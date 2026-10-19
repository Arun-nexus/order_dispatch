import os
import jwt
from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from logger import logging
import time
from mongodb.mongodb_connection import mongodbclient
from configuration import load_params

SECRET_KEY = os.getenv("JWT_SECRET_KEY", "change-this-secret-in-env")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "480")) 

bearer_scheme = HTTPBearer(auto_error=False)

_ACCOUNTS_COLLECTION = load_params()["account_creation_collection_name"]

# ---------------------------------------------------------------------------
# Per-user page access (set from the hidden /access-control page).
# A user whose allowed_pages contains a page also gets the API permissions of
# the role listed here for that page, ON TOP of their own role. This makes a
# granted page actually work, not just open. "admin" is never lent out, and
# admin-only pages (attendance.html, create_account.html) have no entry.
# Edit this map if a page's data calls need a different role.
# ---------------------------------------------------------------------------
PAGE_BORROW_ROLES = {
    "main_dashboard.html": "accounts",
    "orders.html": "accounts",
    "users.html": "accounts",
    "reports.html": "accounts",
    "inventory.html": "inventory_manager",
    "shipment.html": "inventory_manager",
    "assembly.html": "assembly",
    "service.html": "service_manager",
    "allocated.html": "service_manager",
    "dispatch.html": "service_manager",
    "qc.html": "qc",
    "distributor.html": "distributor",
    "distributor_orders.html": "distributor",
    "distributor_team.html": "distributor",
    "technician.html": "technician",
    "technician_dashboard.html": "technician",
}

_ACCESS_CACHE_TTL = 30          # seconds; admin changes reach the API within this time
_access_cache = {}              # username -> (expires_at, frozenset of borrowed roles)


def invalidate_access_cache(username: str = None):
    """Called after an admin changes someone's pages so it applies immediately."""
    if username is None:
        _access_cache.clear()
    else:
        _access_cache.pop(username, None)


def _borrowed_roles(username: str) -> frozenset:
    now = time.time()
    hit = _access_cache.get(username)
    if hit and hit[0] > now:
        return hit[1]
    try:
        rows = mongodbclient().get_data(collection_name=_ACCOUNTS_COLLECTION, query={"username": username})
        pages = (rows[0].get("allowed_pages") if rows else None) or []
        roles = frozenset(PAGE_BORROW_ROLES[p] for p in pages if p in PAGE_BORROW_ROLES)
    except Exception:
        logging.error("page access lookup failed")
        return frozenset()      # fail closed: no extra roles, nothing is cached
    _access_cache[username] = (now + _ACCESS_CACHE_TTL, roles)
    return roles


def create_access_token(username: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": username, "role": role, "exp": expire}
    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return token


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="token expired, please login again")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="invalid token")


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="not authenticated, token missing")
    payload = decode_access_token(credentials.credentials)
    return {"username": payload.get("sub"), "role": payload.get("role")}


def require_role(*allowed_roles):
    # plain def (not async): FastAPI runs it in a worker thread, so the DB lookup never blocks the event loop
    def role_checker(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in allowed_roles and not (_borrowed_roles(user["username"]) & set(allowed_roles)):
            logging.error(f"access denied for role {user['role']}")
            raise HTTPException(status_code=403, detail="you do not have permission for this action")
        return user
    return role_checker