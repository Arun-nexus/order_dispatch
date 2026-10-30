"""Runs the ERP app AND the MCP endpoint (/mcp) in ONE process on ONE port.
ERP's app.py is not edited. Start with:  uvicorn serve:app --host 0.0.0.0 --port $PORT"""
from contextlib import asynccontextmanager

from app import app                      # the ERP FastAPI app
from erp_backend_tools import mcp        # the MCP tools

_mcp = mcp.http_app(path="/mcp")         # ASGI app that serves  POST/GET /mcp
_erp_lifespan = app.router.lifespan_context


@asynccontextmanager
async def _both(a):
    async with _mcp.lifespan(_mcp):      # MCP session manager must be started
        async with _erp_lifespan(a) as state:   # ERP's own startup / shutdown (unchanged)
            yield stateop.o


app.router.lifespan_context = _both
app.router.routes[0:0] = _mcp.routes     # /mcp is matched before any ERP route