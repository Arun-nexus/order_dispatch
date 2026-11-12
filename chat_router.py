import os
import re
import io
import time
import asyncio
import hashlib
import hmac
import secrets
import traceback
from urllib.parse import quote

import jwt
import gridfs
from bson import ObjectId
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Depends, UploadFile, File, Header, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from pymongo.errors import DuplicateKeyError

from mongodb.mongodb_connection import mongodbclient

try:
    import firebase_admin
    from firebase_admin import credentials, messaging
except ImportError:
    firebase_admin = None
    messaging = None

SECRET = os.getenv("chat_jwt_secret") or os.getenv("jwt_secret", "change-this-secret")
EDIT_WINDOW = 300
MAX_FILE = 25 * 1024 * 1024

router = APIRouter(prefix="/chat")

D = mongodbclient().database
fs = gridfs.GridFS(D)
users = D["chat_users"]
chats = D["chats"]
msgs = D["chat_messages"]
tokens_col = D["chat_device_tokens"]
tokens_col.create_index("token", unique=True)

FIREBASE_CRED_PATH = os.getenv("FIREBASE_CRED_PATH", "/app/firebase-service-account.json")
_fb_app = None
if firebase_admin and os.path.exists(FIREBASE_CRED_PATH):
    try:
        _fb_app = firebase_admin.initialize_app(credentials.Certificate(FIREBASE_CRED_PATH))
    except Exception:
        traceback.print_exc()


def now():
    return time.time()


def oid(x):
    try:
        return ObjectId(x)
    except Exception:
        return None


def hash_pw(p, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.scrypt(p.encode(), salt=salt.encode(), n=2 ** 14, r=8, p=1).hex()
    return f"{salt}${h}"


def check_pw(p, stored):
    salt, h = stored.split("$")
    return hmac.compare_digest(hash_pw(p, salt).split("$")[1], h)


def user_pub(u):
    return {"id": str(u["_id"]), "username": u["username"], "name": u["name"], "role": u["role"], "last_seen": u.get("last_seen")}


def token_for(u):
    return jwt.encode({"sub": str(u["_id"]), "exp": now() + 7 * 86400}, SECRET, algorithm="HS256")


def user_from_token(t):
    try:
        uid = jwt.decode(t, SECRET, algorithms=["HS256"])["sub"]
        return users.find_one({"_id": ObjectId(uid)})
    except Exception:
        return None


async def auth(authorization: str = Header(None)):
    u = await asyncio.to_thread(user_from_token, (authorization or "").replace("Bearer ", ""))
    if not u:
        raise HTTPException(401, "Unauthorized")
    return u


async def director(u=Depends(auth)):
    if u["role"] != "director":
        raise HTTPException(403, "Directors only")
    return u


def chat_pub(c):
    return {"id": str(c["_id"]), "name": c["name"], "creator": c["creator"], "members": c["members"], "ttl": c["ttl"], "created": c["created"]}


def msg_pub(m, ttl):
    return {
        "id": str(m["_id"]), "chat_id": m["chat_id"], "sender": m["sender"], "text": m["text"],
        "files": m.get("files", []), "mentions": m.get("mentions", []), "created": m["created"],
        "edited": m.get("edited"), "seen": m.get("seen", {}), "expires": (m["created"] + ttl) if ttl else None,
    }


def get_chat(cid, u):
    o = oid(cid)
    if not o:
        return None
    c = chats.find_one({"_id": o})
    if not c:
        return None
    if u["role"] != "director" and str(u["_id"]) not in c["members"]:
        return None
    return c


def audience(c):
    ds = [str(x["_id"]) for x in users.find({"role": "director"}, {"_id": 1})]
    return list(set(c["members"] + ds))


def existing_ids(ids):
    os_ = [o for o in map(oid, ids) if o]
    return {str(x["_id"]) for x in users.find({"_id": {"$in": os_}}, {"_id": 1})}


def sysmsg(c, text):
    doc = {"chat_id": str(c["_id"]), "sender": "system", "text": text, "files": [], "mentions": [], "created": now(), "seen": {}}
    msgs.insert_one(doc)
    return msg_pub(doc, c["ttl"])


class Hub:
    def __init__(self):
        self.conns = {}

    async def send(self, uids, payload):
        for uid in set(uids):
            for ws in list(self.conns.get(uid, [])):
                try:
                    await ws.send_json(payload)
                except Exception:
                    self.conns[uid].discard(ws)

    async def all(self, payload):
        await self.send(list(self.conns.keys()), payload)


hub = Hub()


class Login(BaseModel):
    username: str
    password: str


class NewUser(BaseModel):
    username: str
    name: str
    password: str
    role: str = "employee"


class EditUser(BaseModel):
    name: str | None = None
    role: str | None = None
    password: str | None = None


class NewChat(BaseModel):
    name: str
    members: list[str] = []
    ttl: int = 0


class Members(BaseModel):
    add: list[str] = []
    remove: list[str] = []


class DeviceToken(BaseModel):
    token: str
    platform: str = "android"


def init_chat():
    users.create_index("username", unique=True)
    msgs.create_index([("chat_id", 1), ("created", 1)])
    if users.count_documents({"role": "director"}) == 0:
        users.insert_one({
            "username": os.getenv("chat_admin_user", "admin"), "name": "Admin", "role": "director",
            "password": hash_pw(os.getenv("chat_admin_pass", "admin123")), "created": now(),
        })


@router.post("/login")
async def login(b: Login):
    u = await asyncio.to_thread(users.find_one, {"username": b.username.strip().lower()})
    if not u or not check_pw(b.password, u["password"]):
        raise HTTPException(401, "Invalid username or password")
    return {"token": token_for(u), "user": user_pub(u)}


@router.get("/me")
async def me(u=Depends(auth)):
    return user_pub(u)


@router.get("/users")
async def list_users(u=Depends(auth)):
    docs = await asyncio.to_thread(lambda: list(users.find()))
    return [user_pub(x) for x in docs]


@router.post("/users")
async def create_user(b: NewUser, u=Depends(director)):
    un = b.username.strip().lower()
    if not re.fullmatch(r"[a-z0-9_]{3,20}", un) or b.role not in ("employee", "director") or len(b.password) < 6 or not b.name.strip():
        raise HTTPException(400, "Invalid details")
    try:
        r = await asyncio.to_thread(users.insert_one, {
            "username": un, "name": b.name.strip(), "role": b.role, "password": hash_pw(b.password), "created": now(),
        })
    except DuplicateKeyError:
        raise HTTPException(409, "Username already exists")
    doc = await asyncio.to_thread(users.find_one, {"_id": r.inserted_id})
    p = user_pub(doc)
    await hub.all({"type": "user", "user": p})
    return p


@router.post("/device-token")
async def register_device_token(b: DeviceToken, u=Depends(auth)):
    await asyncio.to_thread(
        tokens_col.update_one,
        {"token": b.token},
        {"$set": {"user_id": str(u["_id"]), "platform": b.platform, "updated": now()}},
        upsert=True,
    )
    return {"ok": True}


@router.delete("/device-token/{token}")
async def unregister_device_token(token: str, u=Depends(auth)):
    await asyncio.to_thread(tokens_col.delete_one, {"token": token, "user_id": str(u["_id"])})
    return {"ok": True}


def push_to_offline(chat, sender_uid, text, has_files):
    if not _fb_app:
        return
    aud = [m for m in audience(chat) if m != sender_uid and m not in hub.conns]
    if not aud:
        return
    docs = list(tokens_col.find({"user_id": {"$in": aud}}))
    if not docs:
        return
    sender = users.find_one({"_id": oid(sender_uid)})
    sender_name = sender["name"] if sender else "Someone"
    body = (text or "").strip() or ("📎 Attachment" if has_files else "New message")
    fcm_msgs = [
        messaging.Message(
            token=d["token"],
            notification=messaging.Notification(title=sender_name, body=body[:150]),
            data={"chat_id": str(chat["_id"])},
        )
        for d in docs
    ]
    try:
        resp = messaging.send_each(fcm_msgs)
        bad = [docs[i]["token"] for i, r in enumerate(resp.responses) if not r.success]
        if bad:
            tokens_col.delete_many({"token": {"$in": bad}})
    except Exception:
        traceback.print_exc()


def edit_user_sync(uid, u, b):
    o = oid(uid)
    target = users.find_one({"_id": o}) if o else None
    if not target:
        return None, "User not found", 404
    upd = {}
    if b.name is not None:
        if not b.name.strip():
            return None, "Name required", 400
        upd["name"] = b.name.strip()
    if b.role is not None:
        if b.role not in ("employee", "director"):
            return None, "Invalid role", 400
        if target["role"] == "director" and b.role != "director" and users.count_documents({"role": "director"}) <= 1:
            return None, "At least one director must remain", 400
        upd["role"] = b.role
    if b.password is not None and b.password != "":
        if len(b.password) < 6:
            return None, "Password must be at least 6 characters", 400
        upd["password"] = hash_pw(b.password)
    if not upd:
        return None, "Nothing to update", 400
    users.update_one({"_id": o}, {"$set": upd})
    return users.find_one({"_id": o}), None, None


@router.patch("/users/{uid}")
async def edit_user(uid: str, b: EditUser, u=Depends(director)):
    doc, err, code = await asyncio.to_thread(edit_user_sync, uid, u, b)
    if err:
        raise HTTPException(code, err)
    p = user_pub(doc)
    await hub.all({"type": "user", "user": p})
    return p


def delete_user_sync(uid, u):
    o = oid(uid)
    if not o:
        return None, "User not found", 404
    if str(o) == str(u["_id"]):
        return None, "Cannot delete your own account", 400
    target = users.find_one({"_id": o})
    if not target:
        return None, "User not found", 404
    if target["role"] == "director" and users.count_documents({"role": "director"}) <= 1:
        return None, "At least one director must remain", 400
    users.delete_one({"_id": o})
    chats.update_many({"members": uid}, {"$pull": {"members": uid}})
    return target, None, None


@router.delete("/users/{uid}")
async def delete_user(uid: str, u=Depends(director)):
    target, err, code = await asyncio.to_thread(delete_user_sync, uid, u)
    if err:
        raise HTTPException(code, err)
    await hub.all({"type": "user_deleted", "user_id": uid})
    return {"ok": True}


def list_chats(u):
    uid = str(u["_id"])
    q = {} if u["role"] == "director" else {"members": uid}
    out = []
    for c in chats.find(q):
        cid = str(c["_id"])
        ttl = c["ttl"]
        vis = {} if (u["role"] == "director" or not ttl) else {"created": {"$gt": now() - ttl}}
        last = msgs.find_one({"chat_id": cid, **vis}, sort=[("created", -1)])
        unread = msgs.count_documents({"chat_id": cid, "sender": {"$nin": [uid, "system"]}, f"seen.{uid}": {"$exists": False}, **vis})
        p = chat_pub(c)
        p["last"] = msg_pub(last, ttl) if last else None
        p["unread"] = unread
        out.append(p)
    return out


@router.get("/chats")
async def get_chats(u=Depends(auth)):
    return await asyncio.to_thread(list_chats, u)


def make_chat(u, b):
    uid = str(u["_id"])
    valid = existing_ids(b.members)
    members = [uid] + [m for m in dict.fromkeys(b.members) if m != uid and m in valid]
    doc = {"name": b.name.strip()[:60], "creator": uid, "members": members, "ttl": b.ttl if b.ttl > 0 else None, "created": now()}
    chats.insert_one(doc)
    return doc


@router.post("/chats")
async def create_chat(b: NewChat, u=Depends(auth)):
    if not b.name.strip() or not b.members:
        raise HTTPException(400, "Name and members required")
    c = await asyncio.to_thread(make_chat, u, b)
    p = chat_pub(c)
    await hub.send(await asyncio.to_thread(audience, c), {"type": "chat", "chat": p})
    return p


def change_members(u, cid, b):
    c = get_chat(cid, u)
    if not c or not (u["role"] == "director" or c["creator"] == str(u["_id"])):
        return None
    valid = existing_ids(b.add)
    add = [x for x in dict.fromkeys(b.add) if x in valid and x not in c["members"]]
    rem = [x for x in dict.fromkeys(b.remove) if x in c["members"] and x != c["creator"]]
    members = [x for x in c["members"] if x not in rem] + add
    chats.update_one({"_id": c["_id"]}, {"$set": {"members": members}})
    c["members"] = members
    names = {str(x["_id"]): x["name"] for x in users.find({"_id": {"$in": [o for o in map(oid, add + rem + [str(u["_id"])]) if o]}})}
    actor = names.get(str(u["_id"]), "Someone")
    notes = [sysmsg(c, f"{actor} added {names.get(x, 'a user')}") for x in add]
    notes += [sysmsg(c, f"{actor} removed {names.get(x, 'a user')}") for x in rem]
    return c, rem, notes


@router.post("/chats/{cid}/members")
async def members(cid: str, b: Members, u=Depends(auth)):
    r = await asyncio.to_thread(change_members, u, cid, b)
    if not r:
        raise HTTPException(403, "Not allowed")
    c, rem, notes = r
    aud = await asyncio.to_thread(audience, c)
    await hub.send(rem, {"type": "chat_removed", "chat_id": str(c["_id"])})
    await hub.send(aud, {"type": "chat", "chat": chat_pub(c)})
    for n in notes:
        await hub.send(aud, {"type": "message", "message": n})
    return chat_pub(c)


def remove_chat(c):
    cid = str(c["_id"])
    for m in msgs.find({"chat_id": cid}, {"files": 1}):
        for f in m.get("files", []):
            o = oid(f.get("id"))
            if o:
                try:
                    fs.delete(o)
                except Exception:
                    pass
    msgs.delete_many({"chat_id": cid})
    chats.delete_one({"_id": c["_id"]})


@router.delete("/chats/{cid}")
async def delete_chat(cid: str, u=Depends(director)):
    c = await asyncio.to_thread(get_chat, cid, u)
    if not c:
        raise HTTPException(404, "Chat not found")
    aud = await asyncio.to_thread(audience, c)
    await asyncio.to_thread(remove_chat, c)
    await hub.send(aud, {"type": "chat_deleted", "chat_id": cid})
    return {"ok": True}


@router.get("/chats/{cid}/messages")
async def get_messages(cid: str, u=Depends(auth)):
    def run():
        c = get_chat(cid, u)
        if not c:
            return None
        ttl = c["ttl"]
        q = {"chat_id": cid}
        if u["role"] != "director" and ttl:
            q["created"] = {"$gt": now() - ttl}
        docs = list(msgs.find(q).sort("created", -1).limit(500))
        docs.reverse()
        return [msg_pub(m, ttl) for m in docs]

    r = await asyncio.to_thread(run)
    if r is None:
        raise HTTPException(404, "Chat not found")
    return r


@router.post("/upload")
async def upload(file: UploadFile = File(...), u=Depends(auth)):
    data = await file.read()
    if len(data) > MAX_FILE:
        raise HTTPException(413, "File too large (max 25 MB)")
    fid = await asyncio.to_thread(lambda: fs.put(data, filename=file.filename, content_type=file.content_type, owner=str(u["_id"])))
    return {"id": str(fid), "name": file.filename, "size": len(data), "type": file.content_type or ""}


@router.get("/files/{fid}")
async def get_file(fid: str, token: str = Query(...), dl: int = Query(0)):
    u = await asyncio.to_thread(user_from_token, token)
    o = oid(fid)
    if not u:
        raise HTTPException(401, "Unauthorized")
    if not o:
        raise HTTPException(404)
    try:
        f = await asyncio.to_thread(fs.get, o)
        data = await asyncio.to_thread(f.read)
    except Exception:
        raise HTTPException(404)
    return StreamingResponse(
        io.BytesIO(data),
        media_type=f.content_type or "application/octet-stream",
        headers={"Content-Disposition": f"{'attachment' if dl else 'inline'}; filename*=UTF-8''{quote(f.filename or 'file')}"},
    )


def do_send(u, uid, d):
    c = get_chat(d.get("chat_id"), u)
    text = str(d.get("text") or "").strip()[:4000]
    files = [
        {"id": str(f["id"]), "name": str(f.get("name"))[:200], "size": int(f.get("size") or 0), "type": str(f.get("type") or "")}
        for f in (d.get("files") or [])[:10] if isinstance(f, dict) and oid(f.get("id"))
    ]
    if not c or not (text or files):
        return None
    mentions = [m for m in (d.get("mentions") or []) if m in c["members"]]
    doc = {"chat_id": str(c["_id"]), "sender": uid, "text": text, "files": files, "mentions": mentions, "created": now(), "seen": {uid: now()}}
    msgs.insert_one(doc)
    return c, doc


def do_edit(u, uid, d):
    o = oid(d.get("message_id"))
    m = msgs.find_one({"_id": o}) if o else None
    text = str(d.get("text") or "").strip()[:4000]
    if not m or not text or m["sender"] != uid or now() - m["created"] > EDIT_WINDOW:
        return None
    c = get_chat(m["chat_id"], u)
    if not c:
        return None
    mentions = [x for x in (d.get("mentions") or []) if x in c["members"]]
    upd = {"text": text, "mentions": mentions, "edited": now()}
    msgs.update_one({"_id": m["_id"]}, {"$set": upd})
    m.update(upd)
    return c, m


def do_read(u, uid, d):
    c = get_chat(d.get("chat_id"), u)
    if not c:
        return None
    ids = [m["_id"] for m in msgs.find({"chat_id": str(c["_id"]), f"seen.{uid}": {"$exists": False}}, {"_id": 1})]
    if not ids:
        return None
    ts = now()
    msgs.update_many({"_id": {"$in": ids}}, {"$set": {f"seen.{uid}": ts}})
    return c, [str(i) for i in ids], ts


class Msg(BaseModel):
    chat_id: str
    text: str = ""
    mentions: list[str] = []
    files: list[dict] = []


@router.post("/messages")
async def post_message(b: Msg, u=Depends(auth)):
    r = await asyncio.to_thread(do_send, u, str(u["_id"]), b.model_dump())
    if not r:
        raise HTTPException(400, "Cannot send")
    c, m = r
    p = msg_pub(m, c["ttl"])
    await hub.send(await asyncio.to_thread(audience, c), {"type": "message", "message": p})
    await asyncio.to_thread(push_to_offline, c, str(u["_id"]), m["text"], bool(m["files"]))
    return p


async def handle(ws, u, uid, d):
    t = d.get("type")
    if t == "send":
        r = await asyncio.to_thread(do_send, u, uid, d)
        if r:
            c, m = r
            await hub.send(await asyncio.to_thread(audience, c), {"type": "message", "message": msg_pub(m, c["ttl"])})
            await asyncio.to_thread(push_to_offline, c, uid, m["text"], bool(m["files"]))
    elif t == "edit":
        r = await asyncio.to_thread(do_edit, u, uid, d)
        if r:
            c, m = r
            await hub.send(await asyncio.to_thread(audience, c), {"type": "edited", "message": msg_pub(m, c["ttl"])})
        else:
            await ws.send_json({"type": "error", "detail": "Edit not allowed (5 minute window passed)"})
    elif t == "read":
        r = await asyncio.to_thread(do_read, u, uid, d)
        if r:
            c, ids, ts = r
            await hub.send(await asyncio.to_thread(audience, c), {"type": "read", "chat_id": str(c["_id"]), "user": uid, "ids": ids, "ts": ts})
    elif t == "typing":
        c = await asyncio.to_thread(get_chat, d.get("chat_id"), u)
        if c:
            aud = [x for x in await asyncio.to_thread(audience, c) if x != uid]
            await hub.send(aud, {"type": "typing", "chat_id": str(c["_id"]), "user": uid})


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = Query(...)):
    u = await asyncio.to_thread(user_from_token, token)
    if not u:
        await ws.close(code=4401)
        return
    uid = str(u["_id"])
    await ws.accept()
    first = uid not in hub.conns
    hub.conns.setdefault(uid, set()).add(ws)
    await ws.send_json({"type": "presence_all", "online": list(hub.conns.keys())})
    if first:
        await hub.all({"type": "presence", "user": uid, "online": True})
    try:
        while True:
            try:
                d = await ws.receive_json()
            except WebSocketDisconnect:
                break
            except Exception:
                continue
            try:
                await handle(ws, u, uid, d)
            except Exception:
                traceback.print_exc()
    finally:
        hub.conns.get(uid, set()).discard(ws)
        if not hub.conns.get(uid):
            hub.conns.pop(uid, None)
            ts = now()
            await asyncio.to_thread(users.update_one, {"_id": u["_id"]}, {"$set": {"last_seen": ts}})
            await hub.all({"type": "presence", "user": uid, "online": False, "last_seen": ts})