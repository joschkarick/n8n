"""HTTP- und OAuth-Vorbau fuer den Mealie-MCP-Server.

Der Server aus https://github.com/rldiao/mealie-mcp-server startet fest per
stdio (mcp.run(transport="stdio")). Fuer Claude im Web und auf dem iPhone
braucht es aber einen oeffentlich erreichbaren HTTP-Endpunkt mit OAuth.

Dieses Modul uebernimmt beides in einem Prozess:

1. Es importiert das FastMCP-Objekt des Servers und laesst es als Streamable
   HTTP laufen, statt ueber stdio.
2. Es haengt einen OAuth-2.1-Resource-Server davor: Metadata nach RFC 9728
   und Pruefung des Bearer-JWT gegen die JWKS von Authentik.

Authentik selbst steht nicht im Anfragepfad. Es stellt nur Tokens aus.
Der Mealie-API-Token bleibt hier im Container und erreicht Claude nie.
"""

from __future__ import annotations

import logging
import os
import sys
import threading

from urllib.parse import urlparse

import httpx
import jwt
from jwt import PyJWKClient
from jwt.exceptions import PyJWKClientError

try:
    from jwt.exceptions import PyJWKClientConnectionError
except ImportError:  # aeltere PyJWT-Versionen
    PyJWKClientConnectionError = PyJWKClientError
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
log = logging.getLogger("mealie-mcp-gateway")


# --------------------------------------------------------------------------
# Konfiguration
# --------------------------------------------------------------------------

def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Umgebungsvariable {name} fehlt.")
    return value


# Oeffentliche Basis-URL, unter der NPMplus diesen Dienst veroeffentlicht.
PUBLIC_URL = _required("PUBLIC_URL").rstrip("/")

# Authentik-Issuer, z. B. https://authentik.example.com/application/o/mealie-mcp/
OIDC_ISSUER = _required("OIDC_ISSUER").rstrip("/") + "/"

# Erwartete aud-Claim. Authentik setzt hier standardmaessig die Client-ID.
# Leer lassen schaltet die Pruefung ab - nur zum Debuggen sinnvoll.
OIDC_AUDIENCE = os.environ.get("OIDC_AUDIENCE", "").strip() or None

# Pfad, unter dem der MCP-Endpunkt liegt. Vorgabe von FastMCP ist /mcp.
MCP_PATH = os.environ.get("MCP_PATH", "/mcp")

RESOURCE_URL = f"{PUBLIC_URL}{MCP_PATH}"
METADATA_PATH = "/.well-known/oauth-protected-resource"
METADATA_URL = f"{PUBLIC_URL}{METADATA_PATH}"


# --------------------------------------------------------------------------
# Den MCP-Server importieren
# --------------------------------------------------------------------------
# Das Repo nutzt ein src-Layout mit dem Entry Point "server:main", das Objekt
# heisst dort mcp. Sollte sich die Struktur aendern, werden hier der Reihe
# nach die plausiblen Stellen probiert.

_CANDIDATES = (
    ("server", "mcp"),
    ("mealie_mcp_server.server", "mcp"),
    ("mealie_mcp_server", "mcp"),
)

mcp = None
for module_name, attr in _CANDIDATES:
    try:
        module = __import__(module_name, fromlist=[attr])
        mcp = getattr(module, attr)
        log.info("MCP-Server geladen aus %s.%s", module_name, attr)
        break
    except (ImportError, AttributeError):
        continue

if mcp is None:
    sys.exit(
        "Das FastMCP-Objekt wurde nicht gefunden. Pruefe im Container mit\n"
        '  python -c "import server; print(server.mcp)"\n'
        "wie das Modul heisst, und ergaenze es oben in _CANDIDATES."
    )


# --------------------------------------------------------------------------
# JWT-Pruefung gegen Authentik
# --------------------------------------------------------------------------

class AuthServerUnavailable(RuntimeError):
    """Authentik ist nicht erreichbar.

    Das ist ausdruecklich kein Token-Fehler. Wuerde man das als 401
    beantworten, schickt man Claude in eine Neuanmelde-Schleife, obwohl das
    vorhandene Token voellig in Ordnung ist.
    """


class TokenVerifier:
    """Prueft Bearer-Tokens gegen die JWKS des Issuers.

    Die JWKS-URL wird nicht fest verdrahtet, sondern beim ersten Bedarf aus
    dem OpenID-Discovery-Dokument gelesen. So ueberlebt das Setup einen
    Pfadwechsel in Authentik, und der Start haengt nicht daran, dass
    Authentik schon laeuft.
    """

    def __init__(self, issuer: str, audience: str | None) -> None:
        self._issuer = issuer
        self._audience = audience
        self._jwk_client: PyJWKClient | None = None
        self._token_issuer = issuer.rstrip("/")
        self._lock = threading.Lock()

    def _discover(self) -> PyJWKClient:
        with self._lock:
            if self._jwk_client is not None:
                return self._jwk_client

            url = self._issuer + ".well-known/openid-configuration"
            log.info("Hole OpenID-Discovery von %s", url)
            try:
                response = httpx.get(url, timeout=10.0)
                response.raise_for_status()
                document = response.json()
            except httpx.HTTPError as exc:
                raise AuthServerUnavailable(
                    f"Discovery fehlgeschlagen ({url}): {exc}"
                ) from exc

            jwks_uri = document.get("jwks_uri")
            if not jwks_uri:
                raise RuntimeError(f"Discovery-Dokument ohne jwks_uri: {url}")

            # Der Issuer im Token muss dem entsprechen, was der Provider
            # ausweist - nicht dem, was wir konfiguriert haben.
            self._token_issuer = document.get("issuer", self._issuer.rstrip("/"))
            self._jwk_client = PyJWKClient(jwks_uri, cache_keys=True)
            log.info("JWKS-Endpunkt: %s", jwks_uri)
            return self._jwk_client

    def verify(self, token: str) -> dict:
        jwk_client = self._discover()
        try:
            signing_key = jwk_client.get_signing_key_from_jwt(token)
        except PyJWKClientConnectionError as exc:
            raise AuthServerUnavailable(f"JWKS nicht abrufbar: {exc}") from exc

        options = {"verify_aud": self._audience is not None}
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=self._token_issuer,
            audience=self._audience,
            options=options,
        )


verifier = TokenVerifier(OIDC_ISSUER, OIDC_AUDIENCE)


# --------------------------------------------------------------------------
# Endpunkte, die ohne Token erreichbar sein muessen
# --------------------------------------------------------------------------

async def protected_resource_metadata(request: Request) -> Response:
    """RFC 9728. Hierueber findet Claude den zustaendigen Authorization Server."""
    return JSONResponse(
        {
            "resource": RESOURCE_URL,
            "authorization_servers": [OIDC_ISSUER.rstrip("/")],
            "scopes_supported": ["openid", "profile", "email"],
            "bearer_methods_supported": ["header"],
        }
    )


async def healthz(request: Request) -> Response:
    return JSONResponse({"status": "ok", "resource": RESOURCE_URL})


# --------------------------------------------------------------------------
# Auth-Middleware
# --------------------------------------------------------------------------

class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Laesst nur Anfragen mit gueltigem Bearer-JWT durch.

    Die 401-Antwort traegt einen WWW-Authenticate-Header mit Verweis auf die
    Metadata-URL. Genau daran erkennt Claude, wo es sich ein Token holen
    soll - ohne diesen Header bleibt der Verbindungsaufbau stehen.
    """

    _OPEN_PATHS = ("/.well-known/", "/healthz")

    def _challenge(self, error: str, description: str = "") -> Response:
        detail = f'Bearer resource_metadata="{METADATA_URL}", error="{error}"'
        if description:
            safe = description.replace('"', "'")
            detail += f', error_description="{safe}"'
        return JSONResponse(
            {"error": error, "error_description": description},
            status_code=401,
            headers={"WWW-Authenticate": detail},
        )

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        if request.method == "OPTIONS" or any(
            path.startswith(prefix) for prefix in self._OPEN_PATHS
        ):
            return await call_next(request)

        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            return self._challenge("invalid_request", "Bearer-Token fehlt")

        token = header[7:].strip()
        try:
            # Discovery und JWKS-Abruf blockieren. Im Threadpool ausgefuehrt,
            # damit sie den Event-Loop und damit laufende Streams nicht anhalten.
            claims = await run_in_threadpool(verifier.verify, token)
        except AuthServerUnavailable as exc:
            log.error("Authorization Server nicht erreichbar: %s", exc)
            return JSONResponse(
                {
                    "error": "temporarily_unavailable",
                    "error_description": "Authorization Server nicht erreichbar",
                },
                status_code=503,
            )
        except jwt.InvalidAudienceError as exc:
            # Mit Abstand die haeufigste Fehlerursache in diesem Setup.
            log.warning("Token mit falscher Audience abgelehnt: %s", exc)
            return self._challenge(
                "invalid_token",
                f"Audience passt nicht, erwartet wird {OIDC_AUDIENCE}",
            )
        except Exception as exc:
            log.warning("Token abgelehnt: %s: %s", type(exc).__name__, exc)
            return self._challenge("invalid_token", str(exc))

        subject = claims.get("preferred_username") or claims.get("sub")
        log.debug("Anfrage von %s auf %s", subject, path)
        return await call_next(request)


# --------------------------------------------------------------------------
# ASGI-App zusammenbauen
# --------------------------------------------------------------------------
# Wichtig: Die App von FastMCP wird als Basis genommen und nur ergaenzt.
# Wuerde man sie in eine eigene Starlette-App mounten, liefe deren Lifespan
# nicht mit und der Session-Manager des MCP-Servers bliebe uninitialisiert.

if not hasattr(mcp, "streamable_http_app"):
    sys.exit(
        "Das installierte MCP-SDK kennt kein streamable_http_app(). "
        "Bitte mcp[cli] aktualisieren (benoetigt wird mindestens 1.12)."
    )

# Das SDK schuetzt gegen DNS-Rebinding, indem es den Host-Header prueft. Weil
# FastMCP als Host 127.0.0.1 annimmt, steht in der Allowlist sonst nur
# localhost - hinter einem Reverse Proxy kaeme dann fuer jede Anfrage ein
# 421 zurueck. Deshalb wird der oeffentliche Hostname hier ergaenzt.
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402

_public_host = urlparse(PUBLIC_URL).netloc
_extra_hosts = [
    h.strip() for h in os.environ.get("EXTRA_ALLOWED_HOSTS", "").split(",") if h.strip()
]

mcp.settings.transport_security = TransportSecuritySettings(
    enable_dns_rebinding_protection=True,
    allowed_hosts=[
        _public_host,
        f"{_public_host}:*",
        "127.0.0.1:*",
        "localhost:*",
        *_extra_hosts,
    ],
    allowed_origins=[PUBLIC_URL, f"{PUBLIC_URL}:*"],
)

app = mcp.streamable_http_app()
app.router.routes.append(Route(METADATA_PATH, protected_resource_metadata))
# Manche Clients haengen den Ressourcenpfad an die Metadata-URL an.
app.router.routes.append(
    Route(METADATA_PATH + MCP_PATH, protected_resource_metadata)
)
app.router.routes.append(Route("/healthz", healthz))
app.add_middleware(BearerAuthMiddleware)

log.info("Ressource: %s", RESOURCE_URL)
log.info("Metadata:  %s", METADATA_URL)
log.info("Issuer:    %s", OIDC_ISSUER)
log.info("Audience:  %s", OIDC_AUDIENCE or "(Pruefung abgeschaltet)")
log.info("Host-Allowlist: %s", mcp.settings.transport_security.allowed_hosts)
