from fastmcp import FastMCP
from app import app

mcp = FastMCP.from_fastapi(
    app = app,
    name = "erp system"
)

if __name__ == "__main__":
    mcp.run()

    