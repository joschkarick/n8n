FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Der Mealie-MCP-Server wird direkt aus dem Repo installiert. Ein Tag oder
# Commit statt main macht Builds reproduzierbar.
ARG MEALIE_MCP_REF=main
RUN pip install "mealie-mcp-server @ git+https://github.com/rldiao/mealie-mcp-server.git@${MEALIE_MCP_REF}"

COPY requirements.txt .
RUN pip install -r requirements.txt

# Der MCP-Server importiert mcp.server.fastmcp. In mcp 2.x gibt es das nicht
# mehr. Faellt das erst beim Start auf, sieht es wie ein Pfadproblem aus -
# deshalb hier pruefen. Die Version wird vorher ausgegeben, damit im
# Fehlerfall gleich dasteht, welche installiert wurde.
RUN python -c "\
import importlib.metadata as md; \
print('mcp Version:', md.version('mcp')); \
import mcp.server.fastmcp; \
print('mcp.server.fastmcp ok')"

COPY gateway.py .

RUN useradd --create-home --uid 10001 app && chown -R app /app
USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

CMD ["uvicorn", "gateway:app", "--host", "0.0.0.0", "--port", "8000"]
