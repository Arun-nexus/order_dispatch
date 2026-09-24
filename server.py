import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

import json
from fastmcp import FastMCP
from app import app
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


LOGIN_PATH = "/login/" 
_session = {"token": None}


class AutoAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if _session["token"] and b"authorization" not in dict(request.scope["headers"]):
            request.scope["headers"].append(
                (b"authorization", f"Bearer {_session['token']}".encode())
            )

        response = await call_next(request)

        if request.url.path == LOGIN_PATH and response.status_code == 200:
            body_chunks = [chunk async for chunk in response.body_iterator]
            body = b"".join(body_chunks)
            try:
                data = json.loads(body)
                token = data.get("access_token")
                if token:
                    _session["token"] = token
            except Exception:
                pass

            return Response(
                content=body,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.media_type,
            )

        return response


app.add_middleware(AutoAuthMiddleware)

mcp = FastMCP.from_fastapi(
    app=app,
    name="erp system"
)

if __name__ == "__main__":
    mcp.run()