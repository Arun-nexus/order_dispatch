from fastapi import FastAPI, HTTPException, Depends, UploadFile, File, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
from bson import ObjectId
from logger import logging
import urllib.parse
from configuration import load_params
from dotenv import load_dotenv
from mongodb.mongodb_connection import mongodbclient
from user.company import login
from order.manage_order import order_manager
from service.service_details import service_detail, GDRIVE_PLACEHOLDER, ServiceFlowError, SERVICE_LIST_PROJECTION
from gdrive_media import upload_base64_to_drive
from inventory.inventory_handling import inventory_manager
from user.customer_details import customer_manager
from sales.sales_person_manager import sales_person_manager
from allocation.allocation import allocation_manager
from request.request_manager import request_manager
from shipment.manage_shipment import shipment_manager, compute_payment
from assembly.manage_assembly import assembly_manager
from auth import create_access_token, get_current_user, require_role, invalidate_access_cache, _borrowed_roles
from fastapi.responses import FileResponse,RedirectResponse
from fastapi.staticfiles import StaticFiles
import os
import re
import uuid
import base64
import smtplib
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta
import io
import time
import threading
import contextlib
import hashlib
import json
from html.parser import HTMLParser
try:
    from twilio.rest import Client as TwilioClient  
except ImportError:
    TwilioClient = None


def compute_warranty_until(received_date: str, warranty_text: str):
    """
    Parses a free-text warranty duration like "12 months", "1 year", "30 days"
    (as entered on the shipment product) and adds it to received_date
    (YYYY-MM-DD) to get the warranty expiry date. Returns an ISO date string
    (YYYY-MM-DD), or None if either input can't be parsed.
    """
    if not received_date or not warranty_text:
        return None
    match = re.search(r"(\d+)\s*(day|month|year)", warranty_text.strip().lower())
    if not match:
        return None
    amount, unit = int(match.group(1)), match.group(2)
    try:
        base = datetime.strptime(received_date, "%Y-%m-%d")
    except ValueError:
        return None

    if unit == "day":
        result = base + timedelta(days=amount)
    elif unit == "year":
        result = base.replace(year=base.year + amount)
    else:  # month
        total_months = base.month - 1 + amount
        year = base.year + total_months // 12
        month = total_months % 12 + 1
        days_in_month = [31, 29 if (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)) else 28,
                          31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        day = min(base.day, days_in_month[month - 1])
        result = base.replace(year=year, month=month, day=day)

    return result.strftime("%Y-%m-%d")

load_dotenv()

# Desktop-app-only roles: these roles can log in only from the packaged desktop app
# (which sends "key=<APP_CLIENT_KEY>" inside its User-Agent). Configure in .env:
#   APP_CLIENT_KEY=<random secret, same string as in the desktop app>
#   APP_ONLY_ROLES=technician,distributor
# If either is empty, no restriction is applied.
APP_CLIENT_KEY = os.getenv("APP_CLIENT_KEY", "").strip()
APP_ONLY_ROLES = {r.strip() for r in os.getenv("APP_ONLY_ROLES", "").split(",") if r.strip()}
app = FastAPI()
params = load_params()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# resolve everything relative to THIS file's own folder, not whatever
# directory uvicorn happens to be launched from
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ACCOUNTS_COLLECTION = params["account_creation_collection_name"]
NOTIFICATIONS_COLLECTION = params.get("notification_collection_name", "notifications")
ORDERS_COLLECTION = params["order_collection_name"]
SERVICE_COLLECTION = params["service_collection_name"]
INVENTORY_COLLECTION = params["inventory_collection_name"]
CUSTOMER_COLLECTION = params.get("customer_collection_name", "customers")
SALESPERSON_COLLECTION = params.get("salesperson_collection_name", "sales_persons")
ALLOCATION_COLLECTION = params.get("allocation_collection_name", "allocations")
INSTALLATION_COLLECTION = params.get("installation_collection_name", "installations")
REQUESTS_COLLECTION = params.get("requests_collection_name", "requests")
SHIPMENT_COLLECTION = params.get("shipment_collection_name", "shipments")
ASSEMBLY_COLLECTION = params.get("assembly_collection_name", "assemblies")
ATTENDANCE_COLLECTION = params.get("attendance_collection_name", "attendance")
ATTENDANCE_SETTINGS_COLLECTION = params.get("attendance_settings_collection_name", "attendance_settings")

# ---- Damaged-product report settings ----
# Image is emailed out immediately when reported, then wiped from Mongo after
# DAMAGE_IMAGE_RETENTION_DAYS to keep the database light. The issue text and
# who/when metadata are kept forever - only the (large) base64 image is purged.
DAMAGE_IMAGE_RETENTION_DAYS = int(os.getenv("DAMAGE_IMAGE_RETENTION_DAYS", "2"))
GMAIL_SENDER_EMAIL = os.getenv("GMAIL_SENDER_EMAIL", "")
GMAIL_SENDER_APP_PASSWORD = os.getenv("GMAIL_SENDER_APP_PASSWORD", "")
GMAIL_NOTIFY_RECEIVER = os.getenv("GMAIL_NOTIFY_RECEIVER", GMAIL_SENDER_EMAIL)


class LoginRequest(BaseModel):
    username: str
    password: str


class CreateAccountRequest(BaseModel):
    username: str
    password: str
    confirm_password: str
    name: str
    email_id: str
    gst_number: str
    company_name: str
    mobile_no: str
    role: str
    manager: str = ""
    credit_limit: float = 0


class UpdateAccountRequest(BaseModel):
    updated_values: dict


class ServiceRequest(BaseModel):
    product_id: str
    company_name: str = ""
    product_name: str = ""
    model_no: str = ""
    serial_no: str
    technician_id: str
    purchase_date: str
    issue: str
    image: str
    video: str
    location: str = "indoor"
    spare_parts: str = ""
    address: str = ""


class OrderItem(BaseModel):
    product_id: str
    product_name: str
    model_no: str = ""
    product_type: str = ""        # optional: product / accessories / spare_parts ... (part of the stock identity)
    quantity: int
    price: float
    tax_rate: float = 0
    # manually reviewed/chosen serial numbers, one per unit, in order — when
    # given (must have exactly `quantity` entries), these exact serials are
    # deducted instead of auto-allocating oldest-lot-first. Left empty (the
    # default) to keep the old fully-automatic behavior.
    serial_numbers: list[str] = []


class CreateOrderRequest(BaseModel):
    customer_id: str = ""          # set when an existing customer was picked
    customer: dict = {}            # denormalized snapshot: company_name, company_address,
                                    # gst_number, contractor_person, contractor_number, contractor_email
    items: list[OrderItem]
    payment_mode: str
    payment_details: dict = {}     # credit_days / cheque_number+cheque_date / dd_number+dd_date etc.
    discount: float = 0
    warranty_years: int = 1        # standard warranty is 1 year; > 1 means extended
    warranty_charge: float = 0     # additional charge for the extended warranty (0 for standard)
    reference: str = ""            # username of the reference person; required by /order/create_order/


class CustomerRequest(BaseModel):
    company_name: str
    company_address: str = ""
    gst_number: str = ""
    contractor_person: str = ""
    contractor_number: str = ""
    contractor_email: str = ""
    credit_limit: float = 0


class CustomerUpdateRequest(BaseModel):
    updated_values: dict


class CustomerReturnRequest(BaseModel):
    amount: float
    note: str = ""
    return_date: str = ""


class SalesPersonRequest(BaseModel):
    name: str
    company_name: str = ""
    address: str = ""
    contact_number: str = ""
    email: str = ""


class AllocationItem(BaseModel):
    product_id: str
    product_name: str
    quantity: int
    model_no: str = ""
    product_type: str = ""        # optional: part of the stock identity (name + model + type)
    serial_numbers: list[str] = []


class SparePartAllocation(BaseModel):
    service_id: str
    part_name: str
    quantity: int = 1
    # optional: which inventory item was picked. With hologram_numbers those exact units are
    # deducted; with only lot_id the given quantity is deducted from that lot.
    product_id: str = ""
    model_no: str = ""
    product_type: str = ""
    lot_id: str = ""
    hologram_numbers: list[str] = []
    holograms: list[dict] = []
    request_id: str = ""  # spare_part request this allocation fulfils
    manual_holograms: list[str] = []  # hologram numbers typed for stock that has none on file


class CreateAllocationRequest(BaseModel):
    allocated_to: str = ""  # username of a registered system user
    items: list[AllocationItem] = []
    spare_part: SparePartAllocation | None = None
    company_name: str = ""
    address: str = ""
    gst_number: str = ""
    phone_number: str = ""


class CreateDemoUnitRequest(BaseModel):
    customer_id: str = ""
    customer: dict = {}
    items: list[AllocationItem]


class OrderStatusRequest(BaseModel):
    order_id: str


class LateThresholdRequest(BaseModel):
    late_time: str  # "HH:MM", 24-hour format — anyone clocking in after this is marked late


class DispatchConfirmRequest(BaseModel):
    docket_no: Optional[str] = None
    invoice_no: str
    invoice_date: str
    mode_of_delivery: Optional[str] = None
    dispatched_through: Optional[str] = None
    ship_to_different: bool = False
    ship_to_address: Optional[dict]= None   # {company_name, address} — only used when ship_to_different is True
    image: Optional[str] = None   # optional base64 data URI, e.g. packaging/handover photo


class ServicePartUsed(BaseModel):
    part_name: str
    old_hologram_number: str
    new_hologram_number: str


class ServiceUpdateRequest(BaseModel):
    service_status: str
    reason: str = ""
    image: Optional[str] = None
    video: Optional[str] = None
    spare_parts_used: bool = False
    spare_parts: str = ""
    service_charges: Optional[float] = None
    parts_used: list[ServicePartUsed] = []


class ServiceChargeRequest(BaseModel):
    service_charges: float


class ServiceMediaRequest(BaseModel):
    image: Optional[str] = None
    video: Optional[str] = None


class SparePartRequest(BaseModel):
    note: str


class ExtendWarrantyRequest(BaseModel):
    warranty_until: str


# ---- technician service workflow ----
class ServiceStartRequest(BaseModel):
    damage_image: str
    serial_no: str


class FaultyPartIn(BaseModel):
    part_name: str
    old_hologram_number: str
    image: str


class SpareDecisionRequest(BaseModel):
    spare_needed: bool
    parts: List[FaultyPartIn] = []


class NewHologramIn(BaseModel):
    old_hologram_number: str
    new_hologram_number: str


class ServiceReportRequest(BaseModel):
    work_done: str
    parts: List[NewHologramIn] = []
    final_image: Optional[str] = None


class ServiceApproveRequest(BaseModel):
    service_charges: Optional[float] = None


class ServiceSendBackRequest(BaseModel):
    reason: str


class ServiceEditRequest(BaseModel):
    # every field optional: only the fields the admin actually changed are sent
    company_name: Optional[str] = None
    product_name: Optional[str] = None
    model_no: Optional[str] = None
    serial_no: Optional[str] = None
    technician_alloted: Optional[str] = None
    purchase_date: Optional[str] = None
    issue: Optional[str] = None
    location: Optional[str] = None
    address: Optional[str] = None
    spare_parts: Optional[str] = None
    service_charges: Optional[float] = None


class ServiceRescheduleRequest(BaseModel):
    scheduled_date: str
    reason: str = ""


class InstallationCreateRequest(BaseModel):
    product_name: str
    model_no: str = ""
    serial_no: str = ""
    company_name: str
    address: str = ""
    contact_person: str = ""
    contact_number: str = ""
    technician_id: str = ""
    preferred_date: str = ""
    notes: str = ""


class InstallationAssignRequest(BaseModel):
    technician_id: str


class AssignDemoRequest(BaseModel):
    technician_id: str
    items: list[AllocationItem]
    remarks: str = ""


class ReassignDemoRequest(BaseModel):
    technician_id: str


class InstallationScheduleRequest(BaseModel):
    scheduled_date: str
    note: str = ""


class InstallationStatusRequest(BaseModel):
    status: str
    note: str = ""
    image: Optional[str] = None


class OrderUpdatedValue(BaseModel):
    updated_order_value: dict


class InventoryRequest(BaseModel):
    product_name: str
    product_id: str
    quantity: int
    purchase_date: str
    lot_no: str
    supplier: str
    price: str
    tax_rate: int
    model_no: str = ""
    supplier_address: str = ""
    invoice_no: str = ""
    serial_numbers: list[str] = []
    product_type: str = "product"  # "product" | "spare_parts" | "service_parts" | "damaged" | "accessories"
    parent_product_name: str = ""     # spare_parts / service_parts: which product the part belongs to
    part_category: str = ""           # service_parts: "purchase" | "warranty"
    warranty_until: str = ""          # YYYY-MM-DD, parts + damaged
    reason: str = ""                  # damaged: reason of damage
    hologram_numbers: list[str] = []  # spare_parts / service_parts, optional, one per unit
    # supplier ledger: "paid" | "credit" | "" (blank = nothing recorded on the customer ledger)
    payment_mode: str = ""
    supplier_gst: str = ""
    supplier_contact_person: str = ""
    supplier_contact_number: str = ""
    supplier_contact_email: str = ""
    paid_amount: float = 0            # payment_mode "partial": amount paid now (INR)
    credit_days: int = 0              # payment_mode "partial" / "credit": days to pay the rest


class InventoryUpdateRequest(BaseModel):
    updated_values: dict
    new_serial_numbers: list[str] = []
    remove_serial_numbers: list[str] = []
    faulty_serial_numbers: list[str] = []     # pulled off this lot and pushed into the "damaged" category instead of just discarded
    new_hologram_numbers: list[str] = []      # serial-wise hologram numbers to add (spare_parts / service_parts only)
    remove_hologram_numbers: list[str] = []
    source_product_type: Optional[str] = None  # type of the lot being edited (product / damaged / ...)
    model_no: Optional[str] = None


class ShipmentPart(BaseModel):
    part_name: str
    quantity: int = 0
    status: str = "assembly"      # "assembly" (-> inventory spare_parts) | "purchase" | "warranty" (both -> inventory service_parts)


class ShipmentProduct(BaseModel):
    product_name: str
    quantity: int = 0
    price: float = 0
    warranty: str = ""            # e.g. "12 months" - optional
    parts: list[ShipmentPart] = []


class CreateShipmentRequest(BaseModel):
    company_name: str
    company_address: str = ""
    invoice_no: str = ""
    dispatch_date: str
    received_date: str = ""       # optional - can be added later via mark_received
    products: list[ShipmentProduct]
    customer_id: str = ""
    gst_number: str = ""
    contractor_person: str = ""
    contractor_number: str = ""
    contractor_email: str = ""
    payment_mode: str = "paid"    # "paid" | "partial" | "credit"
    paid_amount: float = 0        # partial only: amount paid now (shipment currency)
    credit_days: int = 0          # partial / credit: days within which the rest is paid
    currency: str = "INR"
    exchange_rate: float = 1


class ShipmentReceivedRequest(BaseModel):
    received_date: str


class ShipmentUpdateRequest(BaseModel):
    updated_values: dict


class AssemblyPartUsed(BaseModel):
    part_name: str
    quantity: int = 0
    source: str = "inventory"     # "inventory" (deduct from inventory's spare_parts stock) | "local" (sourced outside, no deduction)
    belongs_to: str = ""          # product the part belongs to (auto-filled from inventory for source="inventory")


class AssemblySerialItem(BaseModel):
    serial_number: str
    lot_no: str = ""      # compulsory per unit (checked in create_assembly); lots may repeat or differ within a batch


class ApproveAssemblyRequest(BaseModel):
    serial_numbers: List[str]


class CreateAssemblyRequest(BaseModel):
    product_name: str
    product_id: str = ""
    model_number: str = ""
    quantity: int
    parts_used: list[AssemblyPartUsed] = []
    serials: list[AssemblySerialItem]


class AssemblyUpdateRequest(BaseModel):
    updated_values: dict


class EditAssemblyRequest(BaseModel):
    product_name: Optional[str] = None
    product_id: Optional[str] = None
    model_number: Optional[str] = None
    parts_used: list[AssemblyPartUsed]


@app.get("/")
def home():
    return RedirectResponse(url = "https://www.acerbiomedicals.com/")


@app.get("/main_dashboard.html")
def dashboard():
    return FileResponse(os.path.join(BASE_DIR, "main_dashboard.html"))


@app.post("/login/")
def login_page(request: LoginRequest, http_request: Request):
    try:
        db = login()
        dataset = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.username})

        if not dataset:
            raise HTTPException(
                status_code=404,
                detail="username was not registered! please create account before login."
            )

        user = dataset[0]

        if user["password"] != request.password:
            raise HTTPException(status_code=401, detail="details did not match")

        if APP_CLIENT_KEY and user["role"] in APP_ONLY_ROLES and request.username not in("arun","prashant","amit","sachin","tarun","manu","gaurav", "sandeep","harsh","manideep","radhey shyam","vijay","aslam"):
            ua = http_request.headers.get("user-agent", "")
            if f"key={APP_CLIENT_KEY}" not in ua:
                raise HTTPException(status_code=403, detail="this role can log in only from the desktop app")

        token = create_access_token(username=user["username"], role=user["role"])

        return {
            "message": "access granted",
            "role": user["role"],
            "allowed_pages": user.get("allowed_pages") or None,
            "access_token": token,
            "token_type": "bearer"
        }

    except HTTPException:
        raise
    except Exception as e:
        logging.error("login was not successful")
        raise HTTPException(status_code=500, detail="login failed")


@app.get("/account/")
def account(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        logging.info("account dataset was fetched successfully")
        return {"message": "account dataset", "dataset": dataset}
    except Exception as e:
        logging.error("account dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="account informations cannot be fetched")


@app.get("/account/my_team")
def my_team(user: dict = Depends(require_role("distributor", "inventory_manager"))):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION,
                               query={"role": "distributor", "manager": user["username"]})
        team = [
            {k: v for k, v in acc.items() if k not in ("password", "confirm_password", "_id")}
            for acc in dataset
        ]
        return {"message": "my team", "dataset": team}
    except Exception as e:
        logging.error("fetching team list failed")
        raise HTTPException(status_code=500, detail="team list cannot be fetched")


@app.get("/allocation/team")
def team_allocations(user: dict = Depends(require_role("distributor", "inventory_manager"))):
    try:
        acc_db = mongodbclient()
        team = acc_db.get_data(collection_name=ACCOUNTS_COLLECTION,
                                query={"role": "distributor", "manager": user["username"]})
        team_usernames = [t["username"] for t in team]
        if not team_usernames:
            return {"message": "no team members", "dataset": []}

        alloc_db = allocation_manager()
        dataset = alloc_db.get_data(collection_name=ALLOCATION_COLLECTION,
                                     query={"allocation_type": {"$in": ["demo_unit", "product"]}, "allocated_by": {"$in": team_usernames}},
                                     projection={"damage_report.image": 0})
        return {"message": "team demo unit allocations", "dataset": dataset}
    except Exception as e:
        logging.error("fetching team allocations failed")
        raise HTTPException(status_code=500, detail="team allocations cannot be fetched")


@app.get("/account/technicians")
def list_technicians(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"role": "technician"})
        technicians = [
            {k: v for k, v in acc.items() if k not in ("password", "confirm_password", "_id")}
            for acc in dataset
        ]
        logging.info("technician list was fetched successfully")
        return {"message": "technician list", "dataset": technicians}
    except Exception as e:
        logging.error("technician list cannot be fetched")
        raise HTTPException(status_code=500, detail="technician list cannot be fetched")


@app.get("/account/distributors")
def list_distributors(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"role": "distributor"})
        distributors = [
            {k: v for k, v in acc.items() if k not in ("password", "confirm_password", "_id")}
            for acc in dataset
        ]
        logging.info("distributor list was fetched successfully")
        return {"message": "distributor list", "dataset": distributors}
    except Exception as e:
        logging.error("distributor list cannot be fetched")
        raise HTTPException(status_code=500, detail="distributor list cannot be fetched")


@app.get("/account/users")
def list_system_users(user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    """Safe (no password) list of every system user, used by the allocation wizard."""
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        users = [
            {"username": a.get("username"), "name": a.get("name") or a.get("username"), "role": a.get("role"),
             "contact_number": a.get("phone", ""), "email": a.get("email", ""), "company_name": a.get("company_name", "")}
            for a in dataset
        ]
        return {"message": "system users", "dataset": users}
    except Exception:
        logging.error("system users cannot be fetched")
        raise HTTPException(status_code=500, detail="users cannot be fetched")


@app.post("/account/create_account/")
def create_account(request: CreateAccountRequest, user: dict = Depends(require_role("admin"))):
    try:
        if request.password != request.confirm_password:
            raise HTTPException(status_code=400, detail="confirm password is not same as password")

        if len(request.mobile_no) != 10 or not request.mobile_no.isdigit():
            raise HTTPException(status_code=400, detail="make sure mobile no is valid")

        db = login()
        existing_user = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.username})

        if existing_user:
            raise HTTPException(status_code=409, detail="username was already registered please try a different username")

        if request.role == "distributor" and request.manager:
            manager_exists = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.manager, "role": "distributor"})
            if not manager_exists:
                raise HTTPException(status_code=400, detail="selected manager was not found among distributor accounts")

        new_user = login(
            username=request.username,
            name=request.name,
            phone=request.mobile_no,
            email=request.email_id,
            company_name=request.company_name,
            gst_number=request.gst_number,
            role=request.role,
            password=request.password
        )
        new_user.add(collection_name=ACCOUNTS_COLLECTION)

        db.update_data(collection_name=ACCOUNTS_COLLECTION, query={"username": request.username},
                        update_values={"credit_limit": request.credit_limit, "credit_used": 0})

        if request.role == "distributor" and request.manager:
            db.update_data(collection_name=ACCOUNTS_COLLECTION, query={"username": request.username},
                            update_values={"manager": request.manager})

        logging.info("account creation was successful")
        return {"message": "account creation was successful"}

    except HTTPException:
        raise
    except Exception as e:
        logging.exception("account creation was failed! role=%s username=%s", request.role, request.username)
        raise HTTPException(status_code=500, detail=f"account creation failed: {e}")


@app.post("/login/delete_account/{username}")
def delete_account(username: str, user: dict = Depends(require_role("admin"))):
    try:
        db = login()
        db.delete(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
        logging.info("account deleted successfully")
        return {"message": "account was deleted successfully", "username": username}

    except Exception as e:
        logging.error("account cannot be deleted.")
        raise HTTPException(status_code=500, detail="account cannot be deleted")


@app.post("/login/update_account/{username}")
def update_account(username: str, updated_values: UpdateAccountRequest, user: dict = Depends(require_role("admin"))):
    try:
        db = login()
        db.update(collection_name=ACCOUNTS_COLLECTION, query={"username": username},
                        update_values=updated_values.updated_values)
        logging.info("account values are updated")
        return {"message": "account details was updated", "username": username,
                "updated_value": updated_values.updated_values}
    except Exception as e:
        logging.error("account details updation was failed")
        raise HTTPException(status_code=500, detail="account details updation was unsuccessful")


# ---------------------------------------------------------------------------
# Page-access control (hidden admin page, not linked in any sidebar)
#   Open  /access-control  in the browser after logging in as admin.
#   A user with allowed_pages set can open ONLY those pages (and sees only
#   those in the sidebar). allowed_pages = None -> the role's default pages.
# ---------------------------------------------------------------------------
ACCESS_PAGE_RE = re.compile(r"^[a-z0-9_]+\.html$")
ACCESS_NON_GRANTABLE = {"access_control.html"}


class AccessUpdateRequest(BaseModel):
    allowed_pages: Optional[List[str]] = None   # None / [] = back to the role's default pages


@app.get("/access-control")
def access_control_page():
    return FileResponse(os.path.join(BASE_DIR, "pages", "access_control.html"))


@app.get("/account/my_access")
def my_access(user: dict = Depends(get_current_user)):
    """Logged-in user's own custom page list (None = role default). Pages call this to stay in sync."""
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": user.get("username")})
        pages = (dataset[0].get("allowed_pages") if dataset else None) or None
        return {"allowed_pages": pages}
    except Exception:
        logging.error("my access cannot be fetched")
        raise HTTPException(status_code=500, detail="access cannot be fetched")


@app.get("/access/users")
def access_users(user: dict = Depends(require_role("admin"))):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        users = [
            {"username": a.get("username"),
             "name": a.get("name") or a.get("full_name") or a.get("username"),
             "role": a.get("role"),
             "allowed_pages": a.get("allowed_pages") or None}
            for a in dataset
        ]
        return {"message": "access users", "dataset": users}
    except Exception:
        logging.error("access users cannot be fetched")
        raise HTTPException(status_code=500, detail="users cannot be fetched")


@app.post("/access/users/{username}")
def set_user_access(username: str, request: AccessUpdateRequest, user: dict = Depends(require_role("admin"))):
    try:
        pages = None
        if request.allowed_pages:
            pages = []
            for p in request.allowed_pages:
                p = str(p).strip()
                if not ACCESS_PAGE_RE.match(p):
                    raise HTTPException(status_code=400, detail=f"invalid page {p}")
                if p not in ACCESS_NON_GRANTABLE and p not in pages:
                    pages.append(p)
            pages = pages or None

        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
        if not dataset:
            raise HTTPException(status_code=404, detail="user not found")

        db.update_data(collection_name=ACCOUNTS_COLLECTION, query={"username": username},
                       update_values={"allowed_pages": pages})
        invalidate_access_cache(username)
        logging.info("page access updated for %s", username)
        return {"message": "access updated", "username": username, "allowed_pages": pages}
    except HTTPException:
        raise
    except Exception:
        logging.error("page access cannot be updated")
        raise HTTPException(status_code=500, detail="access cannot be updated")


VALID_PAYMENT_MODES = {"Credit", "Partial", "NetBanking", "UPI", "Cheque", "DemandDraft", "Cash"}


def _order_grand_total(items: list, discount: float = 0, warranty_charge: float = 0) -> float:
    """price x qty + tax per line, minus discount, plus extended-warranty charge (same maths as order_manager.add)."""
    total = 0.0
    for it in items or []:
        line = float(it.get("price", 0) or 0) * float(it.get("quantity", 0) or 0)
        total += line + line * float(it.get("tax_rate", 0) or 0) / 100
    return round(total - float(discount or 0) + float(warranty_charge or 0), 2)


def _validate_order_payment(payment_mode: str, payment_details: dict, grand_total: float = 0) -> dict:
    """Checks the payment mode + its details (shared by order creation and demo-unit conversion)
    and returns the details to store. "Partial" = part paid now, the rest (balance) due after
    credit_days; paid_amount / credit_days come in, balance_amount / due_date are added here."""
    details = dict(payment_details or {})

    if not payment_mode:
        raise HTTPException(status_code=400, detail="select a payment mode")
    if payment_mode not in VALID_PAYMENT_MODES:
        raise HTTPException(status_code=400, detail="invalid payment mode")

    if payment_mode == "Credit":
        credit_days = details.get("credit_days")
        if not credit_days or not (0 < int(credit_days) <= 60):
            raise HTTPException(status_code=400, detail="credit days must be between 1 and 60")

    if payment_mode == "Partial":
        try:
            paid = float(details.get("paid_amount") or 0)
            days = int(details.get("credit_days") or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="invalid partial payment details")
        if paid <= 0:
            raise HTTPException(status_code=400, detail="enter the amount paid now for a partial payment")
        if not (0 < days <= 60):
            raise HTTPException(status_code=400, detail="days for the remaining payment must be between 1 and 60")
        if grand_total > 0 and paid >= grand_total:
            raise HTTPException(status_code=400, detail="partial payment must be less than the order total - choose another payment mode")
        details["paid_amount"] = round(paid, 2)
        details["credit_days"] = days
        details["balance_amount"] = round(max(grand_total - paid, 0), 2)
        details["due_date"] = (datetime.now(timezone.utc) + timedelta(days=days)).date().isoformat()

    if payment_mode == "Cheque" and not details.get("cheque_number"):
        raise HTTPException(status_code=400, detail="cheque number is required")

    if payment_mode == "DemandDraft" and not details.get("dd_number"):
        raise HTTPException(status_code=400, detail="demand draft number is required")

    if payment_mode == "UPI" and not details.get("upi_id"):
        raise HTTPException(status_code=400, detail="UPI ID is required")

    if payment_mode == "NetBanking" and not (
        details.get("bank_name")
        and details.get("account_number")
        and details.get("ifsc_code")
    ):
        raise HTTPException(status_code=400, detail="bank name, account number and IFSC code are required")

    if payment_mode == "Cash" and not details.get("received_by"):
        raise HTTPException(status_code=400, detail="received-by person name is required")

    return details


def _raise_media_review_request(service_id: str, raised_by: str):
    """Creates a 'media_review' request so admin/accounts get a bell notification
    to download the uploaded video. Approving it confirms the download and clears
    the video from the database; rejecting it discards the video without keeping it."""
    try:
        req = request_manager(
            request_type="media_review",
            raised_by=raised_by,
            details={"service_id": service_id, "kind": "video"}
        )
        req.add(collection_name=REQUESTS_COLLECTION)
    except Exception:
        logging.error("could not raise media review notification")


def _damaged_part_warranty(old_hologram: str):
    """Looks up which shipment lot the removed part (identified by its old
    hologram number) came from - i.e. the spare_parts/service_parts
    inventory entry whose hologram_numbers list contains this hologram - and
    returns that lot's warranty_until (or None if the hologram isn't found
    on any lot, or the lot was never covered by a warranty)."""
    inv_db = inventory_manager()
    entries = inv_db.get_data(
        collection_name=INVENTORY_COLLECTION,
        query={"hologram_numbers": old_hologram, "product_type": {"$in": ["spare_parts", "service_parts"]}}
    )
    if not entries:
        return None
    return entries[0].get("warranty_until")


def _faulty_already_filed(part_name: str, old_hologram: str) -> bool:
    """True when this removed part (name + old hologram number) already sits in the Damaged inventory."""
    if not old_hologram:
        return False
    found = inventory_manager().get_data(
        collection_name=INVENTORY_COLLECTION,
        query={"product_type": "damaged", "product_id": old_hologram, "product_name": part_name})
    return bool(found)


def _record_faulty_filed(service_id: str, holograms: list):
    """Remember on the service which old hologram numbers were filed as faulty (shown on the Allocated Parts card)."""
    try:
        svc_db = service_detail()
        svc = svc_db.get_service_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        have = list((svc[0].get("faulty_filed") if svc else None) or [])
        merged = have + [h for h in holograms if h and h not in have]
        svc_db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id},
                           update_values={"faulty_filed": merged})
    except Exception as e:
        logging.error(f"could not record faulty_filed for {service_id}: {e}")


def _swap_faulty_part(service_id: str, parts_used: list):
    """When a service is closed with spare part(s) used: for each part,
    checks the entered old hologram number against the hologram currently
    on file for the product's serial number in the assembly record (a
    mismatch is only a warning, never blocks), rolls the assembly record's
    hologram forward to that part's new hologram number, and adds the
    removed part into inventory as a damaged product (name = part name,
    product_id = its old hologram number).

    Before filing it as damaged, the shipment lot the part originally came
    from (matched via its old hologram number) is looked up so we know
    whether that lot's warranty is still valid:
      - still under warranty -> warranty_until is carried onto the damaged
        entry, so /inventory/'s dynamic warranty_status calc marks it
        "under warranty" (and how many days are left) automatically
      - warranty expired, or no shipment lot/warranty found at all -> marked
        "over warranty", and this service's service_id is recorded in the
        damaged entry's `reason` field for traceability

    Returns True if any part's old hologram number did not match what's on
    file (or couldn't be verified)."""
    svc_db = service_detail()
    svc = svc_db.get_service_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
    if not svc:
        return False
    serial_no = svc[0].get("serial_no")

    assembly = None
    serials = None
    serial_entry = None
    if serial_no:
        asm_db = assembly_manager()
        assemblies = asm_db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"serials.serial_number": serial_no})
        if assemblies:
            assembly = assemblies[0]
            serials = assembly.get("serials", [])
            for s in serials:
                if s.get("serial_number") == serial_no:
                    serial_entry = s
                    break

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    mismatch = False
    filed_now = []
    for part in parts_used:
        part_name = part.get("part_name")
        old_hologram = part.get("old_hologram_number")
        new_hologram = part.get("new_hologram_number")

        if serial_entry is not None:
            recorded_hologram = serial_entry.get("hologram_number") or ""
            if recorded_hologram and recorded_hologram != old_hologram:
                mismatch = True
            serial_entry["replaced"] = True
            serial_entry["previous_hologram_number"] = old_hologram
            serial_entry["hologram_number"] = new_hologram
        else:
            mismatch = True

        warranty_until = _damaged_part_warranty(old_hologram)
        under_warranty = bool(warranty_until) and warranty_until >= today
        # only when the part is already out of warranty (or its shipment lot
        # couldn't be traced at all) do we stamp the damage reason with this
        # service's service_id - an in-warranty part doesn't need that
        # trail, its warranty_until on the entry already tells the story
        reason = "" if under_warranty else f"damaged part removed during service {service_id}"

        # already filed as faulty (e.g. the manager used "Add to faulty" on the service page) -> don't add it twice
        if not _faulty_already_filed(part_name, old_hologram):
            inv_db = inventory_manager(product_name=part_name, product_id=old_hologram,
                                        quantity=1, product_type="damaged",
                                        warranty_until=warranty_until, reason=reason)
            inv_db.add(collection_name=INVENTORY_COLLECTION)
        filed_now.append(old_hologram)

    if filed_now:
        _record_faulty_filed(service_id, filed_now)

    if assembly is not None and serials is not None:
        asm_db.update(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly["assembly_id"]},
                      update_values={"serials": serials})

    logging.info(f"faulty part(s) swapped for service {service_id}: {len(parts_used)} part(s) processed")
    return mismatch


# ---- never hand out a serial number that is already sold ----
# Inventory lots can still list a serial that a live order / demo allocation already holds
# (stale lot data, a restock that was never cleaned up, the same serial in two lots ...).
# These helpers cross-check inventory serials against orders + allocations before auto-picking.
_ORDER_STATUSES_NOT_HOLDING_STOCK = ["cancelled", "returned"]
# Inventory is the source of truth: a serial that sits in an inventory lot is sellable / demo-able.
# Set to True to also hide serials that an old order / un-returned allocation still mentions.
ENFORCE_SOLD_SERIAL_CROSSCHECK = False


def _unsold_serials(serials):
    """Returns the serials (original order kept) that are NOT held by a live order or a live
    (not returned) allocation. Serials of returned orders that were restocked count as free."""
    serials = [s for s in (serials or []) if s]
    if not serials or not ENFORCE_SOLD_SERIAL_CROSSCHECK:
        return serials
    db = mongodbclient()
    taken = set()   # lower-cased / trimmed: stored serials are not consistently the same case
    for o in db.get_data(collection_name=ORDERS_COLLECTION,
                         query={"items.serial_numbers": {"$in": serials},
                                "status": {"$nin": _ORDER_STATUSES_NOT_HOLDING_STOCK}}):
        back_in_stock = set(o.get("returned_serials_processed") or [])
        for it in (o.get("items") or []):
            for sn in (it.get("serial_numbers") or []):
                if sn not in back_in_stock:
                    taken.add(str(sn).strip().lower())
    for a in db.get_data(collection_name=ALLOCATION_COLLECTION,
                         query={"items.serial_numbers": {"$in": serials},
                                "return_status": {"$ne": "returned"}}):
        for it in (a.get("items") or []):
            for sn in (it.get("serial_numbers") or []):
                taken.add(str(sn).strip().lower())
    return [sn for sn in serials if str(sn).strip().lower() not in taken]


def _item_ident(item):
    """(product_name, model_no, product_type) - what makes two stock lines "the same product".
    product_id is deliberately NOT part of it: inventory products carry a blank / single-space id."""
    g = item.get if isinstance(item, dict) else (lambda k, d=None: getattr(item, k, d))
    return ((g("product_name") or "").strip(), (g("model_no") or "").strip(), (g("product_type") or "").strip())


def _sellable_quantity(inventory_db, product_id: str, model_no=None, product_name=None, product_type=None):
    """How many units of this product can really be handed out right now.
    Returns (sellable, skipped_sold_serials). Serialised stock: serials not held by a live order /
    allocation, plus units of the lot that have no serial on file (a lot may hold more units than
    serials). Fully un-serialised stock: the plain quantity."""
    kw = dict(model_no=model_no or None, product_name=product_name or None, product_type=product_type or None)
    candidates = inventory_db.list_available_serials(INVENTORY_COLLECTION, product_id, **kw)
    if not candidates:
        return inventory_db.get_available_quantity(INVENTORY_COLLECTION, product_id, **kw), 0
    clean = _unsold_serials(candidates)
    unserialised = inventory_db.unserialised_quantity(INVENTORY_COLLECTION, product_id, **kw)
    return len(clean) + unserialised, len(candidates) - len(clean)


def _stock_short_detail(name: str, sellable: int, skipped: int, variant_note: str = "") -> str:
    detail = f"insufficient stock for {name}{variant_note}: only {sellable} available"
    if skipped:
        detail += f" ({skipped} serial(s) on file are already sold - fix them in Inventory)"
    return detail


def _auto_pick_units(inventory_db, product_id: str, quantity: int, model_no=None, product_name=None, product_type=None):
    """Auto-allocation that skips already-sold serials. The product is identified by product name +
    model no + product type (product_id only when no name is given). Serialised stock: the oldest
    UNSOLD serials are picked first; if the lot holds more units than serials on file, the rest are
    taken as un-serialised units (so the returned serial list may be shorter than `quantity`).
    Un-serialised stock (accessories / spare parts with no serial on file) keeps using
    the plain quantity allocator, since there is nothing to cross-check."""
    kw = dict(model_no=model_no or None, product_name=product_name or None, product_type=product_type or None)
    candidates = inventory_db.list_available_serials(INVENTORY_COLLECTION, product_id, **kw)
    if not candidates:
        return inventory_db.allocate_units(collection_name=INVENTORY_COLLECTION, product_id=product_id,
                                           quantity=quantity, **kw)
    clean = _unsold_serials(candidates)
    if len(clean) >= quantity:
        return inventory_db.allocate_specific_serials(collection_name=INVENTORY_COLLECTION, product_id=product_id,
                                                      serial_numbers=clean[:quantity], **kw)
    # not enough clean serials - the lot may simply hold more units than serials on file
    unserialised = inventory_db.unserialised_quantity(INVENTORY_COLLECTION, product_id, **kw)
    sellable = len(clean) + unserialised
    if sellable < quantity:
        raise HTTPException(status_code=400,
                            detail=_stock_short_detail(product_name or product_id, sellable, len(candidates) - len(clean)))
    # un-serialised units first (can't half-fail after serials are gone), then the clean serials
    inventory_db.allocate_unserialised_units(INVENTORY_COLLECTION, product_id, quantity - len(clean), **kw)
    if not clean:
        return []
    return inventory_db.allocate_specific_serials(collection_name=INVENTORY_COLLECTION, product_id=product_id,
                                                  serial_numbers=clean, **kw)


def _auto_pick_item(inventory_db, item: dict):
    """_auto_pick_units for a request/order/allocation item dict."""
    name, model, ptype = _item_ident(item)
    return _auto_pick_units(inventory_db, item.get("product_id", ""), item["quantity"], model or None,
                            product_name=name or None, product_type=ptype or None)


def _rollback_stock(inventory_db, deducted):
    """Puts back stock that was already deducted when a later step of the same approval failed,
    so a failed approve doesn't leave the request pending with half its stock gone.
    deducted = [(item_dict, serials_list), ...]"""
    for item, serials in reversed(deducted):
        try:
            serials = [s for s in (serials or []) if s]
            qty = int(item.get("quantity", 0) or 0)
            pid, name, model = item.get("product_id"), item.get("product_name"), item.get("model_no") or ""
            if serials:
                inventory_db.restock_returned_units(INVENTORY_COLLECTION, pid, name, model, len(serials),
                                                    serial_numbers=serials)
            rest = qty - len(serials)
            if rest > 0:
                inventory_db.restock_returned_units(INVENTORY_COLLECTION, pid, name, model, rest)
        except Exception as rb_err:
            logging.error(f"stock rollback failed for {item.get('product_id')}: {rb_err}")


def _fulfill_order(customer_id: str, customer: dict, items: list, payment_mode: str, payment_details: dict, discount: float, creator: dict = None, warranty_years: int = 1, warranty_charge: float = 0):
    """Validates payment details, resolves/creates the customer, deducts stock + serials,
    and creates the order record. Shared by the direct /order/create_order/ endpoint and by
    /request/approve/{request_id} when a distributor's order request is approved."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product to the order")

    payment_details = _validate_order_payment(payment_mode, payment_details, _order_grand_total(items, discount, warranty_charge))

    customer_db = customer_manager()
    customer_snapshot = dict(customer or {})

    if customer_id:
        existing = customer_db.get_data(CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not existing:
            raise HTTPException(status_code=404, detail="selected customer not found")
        customer_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
    else:
        if not customer_snapshot.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")
        new_customer = customer_manager(
            company_name=customer_snapshot.get("company_name"),
            company_address=customer_snapshot.get("company_address"),
            gst_number=customer_snapshot.get("gst_number"),
            contractor_person=customer_snapshot.get("contractor_person"),
            contractor_number=customer_snapshot.get("contractor_number"),
            contractor_email=customer_snapshot.get("contractor_email"),
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)
        creator_username = (creator or {}).get("raised_by") or (creator or {}).get("username")
        if creator_username:
            customer_db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                     update_values={"created_by": creator_username})
        customer_snapshot = {
            "customer_id": new_customer.customer_id,
            "company_name": new_customer.company_name,
            "company_address": new_customer.company_address,
            "gst_number": new_customer.gst_number,
            "contractor_person": new_customer.contractor_person,
            "contractor_number": new_customer.contractor_number,
            "contractor_email": new_customer.contractor_email,
            "created_by": creator_username,
        }

    inventory_db = inventory_manager()
    qty_by_variant = {}
    for item in items:
        key = _item_ident(item)
        qty_by_variant[key] = qty_by_variant.get(key, 0) + item["quantity"]

    for (pname, model_no, ptype), total_qty in qty_by_variant.items():
        product_id = next((it.get("product_id", "") for it in items if _item_ident(it) == (pname, model_no, ptype)), "")
        available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, product_id, model_no=model_no or None,
                                                         product_name=pname or None, product_type=ptype or None)
        if available < total_qty:
            sample_name = pname or product_id
            variant_note = f" (model {model_no})" if model_no else ""
            raise HTTPException(
                status_code=400,
                detail=f"insufficient stock for {sample_name}{variant_note}: only {available} available"
            )

    deducted = []
    try:
        order_items = []
        for item in items:
            chosen_serials = item.get("serial_numbers") or []
            if chosen_serials:
                if len(chosen_serials) != item["quantity"]:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{item.get('product_name', item['product_id'])}: {len(chosen_serials)} serial number(s) given but quantity is {item['quantity']}"
                    )
                if len(set(chosen_serials)) != len(chosen_serials):
                    raise HTTPException(status_code=400, detail=f"{item.get('product_name', item['product_id'])}: duplicate serial numbers selected")
                try:
                    allocated_serials = inventory_db.allocate_specific_serials(
                        collection_name=INVENTORY_COLLECTION,
                        product_id=item["product_id"],
                        serial_numbers=chosen_serials,
                        model_no=item.get("model_no") or None,
                        product_name=item.get("product_name") or None,
                        product_type=item.get("product_type") or None
                    )
                except Exception as e:
                    raise HTTPException(status_code=400, detail=str(e))
            else:
                allocated_serials = _auto_pick_item(inventory_db, item)
            deducted.append((item, allocated_serials))
            order_item = dict(item)
            order_item["serial_numbers"] = allocated_serials
            order_item["serial_lots"] = inventory_db.lots_for(allocated_serials)
            order_items.append(order_item)

        order = order_manager(
            customer=customer_snapshot,
            items=order_items,
            payment_mode=payment_mode,
            payment_details=payment_details,
            discount=discount,
            creator=creator or {},
            warranty_years=warranty_years,
            warranty_charge=warranty_charge
        )
        order.add(collection_name=ORDERS_COLLECTION)
    except Exception:
        _rollback_stock(inventory_db, deducted)
        raise

    logging.info(f"order {order.order_id} created successfully")
    return order.order_id


@app.post("/order/create_order/")
def create_order(request: CreateOrderRequest, user: dict = Depends(require_role("admin", "accounts"))):
    reference = (request.reference or "").strip()
    if not reference:
        raise HTTPException(status_code=400, detail="reference is required, please select a reference user")
    try:
        if not mongodbclient().get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": reference}):
            raise HTTPException(status_code=400, detail="selected reference user does not exist")
        order_id = _fulfill_order(
            customer_id=request.customer_id,
            customer=request.customer,
            items=[item.dict() for item in request.items],
            payment_mode=request.payment_mode,
            payment_details=request.payment_details,
            discount=request.discount,
            creator={"type": "direct", "created_by": user["username"]},
            warranty_years=request.warranty_years,
            warranty_charge=request.warranty_charge
        )
        order_manager().update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id},
                               update_values={"reference": reference})
        return {"message": "order created successfully", "order_id": order_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("order creation failed!")
        raise HTTPException(status_code=500, detail="order creation failed")


@app.get("/track_order/{order_id}")
def track_order(order_id: str, user: dict = Depends(get_current_user)):
    try:
        db = order_manager()
        dataset = db.get_data(ORDERS_COLLECTION, query={"order_id": order_id})

        if not dataset:
            raise HTTPException(status_code=404, detail="no order found with this order_id")
        return dataset[0]

    except HTTPException:
        raise
    except Exception as e:
        logging.error("order tracking failed!")
        raise HTTPException(status_code=500, detail="order tracking failed!")


@app.post("/order/confirm_delivery/{order_id}")
def confirm_delivery(order_id: str, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = order_manager()
        result = db.update(
            ORDERS_COLLECTION,
            query={"order_id": order_id},
            update_values={"status": "delivered"}
        )

        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="no order found with this id")

        return {"message": "delivery confirmed", "order_id": order_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("delivery confirmation failed")
        raise HTTPException(status_code=500, detail="delivery confirmation failed")


@app.post("/order/delete/{order_id}")
def delete_order(order_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = order_manager()
        existing = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        # Deleting an order removes the record entirely, so — same reasoning as
        # cancelling — the stock/serials it reserved at creation time must go
        # back into inventory, or it's permanently lost from stock even though
        # nothing physically shipped. Skip if it was already cancelled: that
        # restock already happened via /order/update.
        if existing and existing[0].get("status") != "cancelled" and not existing[0].get("dispatch"):
            try:
                for item in existing[0].get("items", []):
                    product_id = item.get("product_id")
                    qty = item.get("quantity", 0) or 0
                    if not product_id or qty <= 0:
                        continue
                    inventory_manager(
                        product_name=item.get("product_name", ""),
                        product_id=product_id,
                        quantity=qty,
                        model_no=item.get("model_no", ""),
                        price=item.get("price", 0),
                        tax_rate=item.get("tax_rate", 0),
                        serial_numbers=item.get("serial_numbers", []) or [],
                        serial_lots=item.get("serial_lots") or [],
                    ).add_or_merge(collection_name=INVENTORY_COLLECTION)
                logging.info(f"order {order_id} deleted — items restocked to inventory")
            except Exception as restock_err:
                logging.error(f"order {order_id} deleted but restocking inventory failed: {restock_err}")
        db.delete(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        return {"message": "order deleted", "order_id": order_id}
    except Exception as e:
        logging.error("order deletion failed")
        raise HTTPException(status_code=500, detail="order deletion failed!")


@app.post("/order/update/{order_id}")
def update_order(order_id: str, updated_value: OrderUpdatedValue, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = order_manager()
        updated = dict(updated_value.updated_order_value)

        existing = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no order found with this order_id")
        order = existing[0]

        # Any of these being present means this is a real edit made via the
        # Edit Order modal (as opposed to a plain status change from the
        # Update Status modal, which carries its own cancel_reason and none
        # of these keys) — a remark is mandatory for those so the order
        # history stays meaningful. Checked against the untouched `updated`
        # dict, before any of the branches below start popping keys off it.
        item_field_keys_check = {"product_name", "serial_no", "quantity", "price", "tax_rate"}
        is_edit = bool(
            (item_field_keys_check & updated.keys())
            or "discount" in updated
            or "items" in updated
            or "payment_mode" in updated
            or "company_name" in updated
            or "gst_number" in updated
        )
        remark = (updated.pop("remark", "") or "").strip()
        if is_edit and not remark:
            raise HTTPException(status_code=400, detail="a remark is required when editing an order")

        # Cancelling an order releases the stock/serials it reserved at creation
        # time (_fulfill_order deducts inventory immediately, before delivery)
        # back into inventory — otherwise every cancelled order's units are
        # permanently lost from stock even though nothing physically shipped.
        # Guarded on the order's CURRENT status so re-saving an already-cancelled
        # order (e.g. editing the cancel reason) never restocks twice.
        if updated.get("status") == "cancelled" and order.get("status") != "cancelled":
            if order.get("dispatch"):
                # already physically dispatched — nothing to give back to inventory
                logging.info(f"order {order_id} cancelled after dispatch — inventory left untouched")
            else:
                try:
                    for item in order.get("items", []):
                        product_id = item.get("product_id")
                        qty = item.get("quantity", 0) or 0
                        if not product_id or qty <= 0:
                            continue
                        inventory_manager(
                            product_name=item.get("product_name", ""),
                            product_id=product_id,
                            quantity=qty,
                            model_no=item.get("model_no", ""),
                            price=item.get("price", 0),
                            tax_rate=item.get("tax_rate", 0),
                            serial_numbers=item.get("serial_numbers", []) or [],
                            serial_lots=item.get("serial_lots") or [],
                        ).add_or_merge(collection_name=INVENTORY_COLLECTION)
                    logging.info(f"order {order_id} cancelled — items restocked to inventory")
                except Exception as restock_err:
                    logging.error(f"order {order_id} cancelled but restocking inventory failed: {restock_err}")

        # Marking an order "returned" needs to know exactly which product(s)
        # came back (an order can have multiple/coupled products) and, for
        # each, whether it came back in working condition or faulty — sent
        # by the caller as "returned_items": [{product_id, product_name,
        # model_no, quantity, serial_numbers, condition: "ok"|"faulty"}].
        # OK units go back into whatever category they were already stocked
        # under (restock_returned_units — merges into the matching
        # product_id+product_name+model_no lot, or creates one). Faulty
        # units are instead pushed into the "damaged" inventory category
        # (merges into an existing damaged entry for the same
        # product_id+model_no, quantity bumped up, or creates a new one).
        #
        # IMPORTANT: this runs on EVERY submission where status=="returned",
        # not just the first — once an order is already "returned", e.g. the
        # Update Status modal is reopened to correct a mistake (an item that
        # should've been "faulty" was first saved as "ok", or a second item
        # is being returned later), the old code's "only if the order wasn't
        # already returned" guard silently skipped ALL processing on every
        # later submission with no error, so the correction never reached
        # inventory even though the request looked successful. Each
        # already-processed serial number (or, for unserialized lines,
        # already-processed quantity per product_id+model_no) is tracked on
        # the order itself so re-submitting doesn't restock/damage the same
        # unit twice, while still letting genuinely NEW lines/serials in this
        # submission go through.
        if updated.get("status") == "returned":
            return_reason = (updated.get("return_reason") or "").strip()
            returned_items = updated.get("returned_items") or []
            if not return_reason:
                raise HTTPException(status_code=400, detail="a reason is required when marking an order as returned")
            if not returned_items:
                raise HTTPException(status_code=400, detail="select at least one product that was returned")

            already_serials = set(order.get("returned_serials_processed") or [])
            already_qty = dict(order.get("returned_qty_processed") or {})
            newly_processed_serials = []
            processed_records = []  # what actually got processed this submission — for order history/view

            inv_db = inventory_manager()
            for ret_item in returned_items:
                product_id = ret_item.get("product_id")
                product_name = ret_item.get("product_name", "")
                model_no = ret_item.get("model_no", "") or ""
                serials = [s for s in (ret_item.get("serial_numbers") or []) if s]
                condition = ret_item.get("condition")  # "ok" | "faulty"
                if not product_id:
                    continue

                qty_key = f"{product_id}|{model_no}"
                if serials:
                    fresh_serials = [s for s in serials if s not in already_serials]
                    if not fresh_serials:
                        continue  # every serial on this line was already processed in an earlier submission
                    quantity = len(fresh_serials)
                else:
                    already_done = int(already_qty.get(qty_key, 0) or 0)
                    requested_qty = int(ret_item.get("quantity", 0) or 0)
                    quantity = max(0, requested_qty - already_done)
                    fresh_serials = []
                    if quantity <= 0:
                        continue  # this line's quantity was already fully processed earlier

                try:
                    if condition == "faulty":
                        # Deliberately NOT using add_or_merge() here — its
                        # cross-category "serial found under a different
                        # product_type elsewhere" migration logic is meant for
                        # the manual "Add Existing Product" restock flow and
                        # isn't needed for a fresh return (the serial isn't
                        # anywhere else in inventory at this point, it was
                        # already deducted when the order was created). A plain,
                        # direct merge-by-product_id+model_no+product_type here
                        # is simpler and avoids that logic misfiring.
                        existing_damaged = inv_db.get_data(
                            collection_name=INVENTORY_COLLECTION,
                            query={"product_id": product_id, "model_no": model_no, "product_type": "damaged"}
                        )
                        damage_reason = f"returned faulty from order {order_id}: {return_reason}"
                        if existing_damaged:
                            entry = existing_damaged[0]
                            merged_serials = (entry.get("serial_numbers") or []) + list(fresh_serials)
                            new_quantity = int(entry.get("quantity", 0) or 0) + quantity
                            inv_db.update(
                                collection_name=INVENTORY_COLLECTION,
                                query={"_id": ObjectId(entry["_id"])},
                                update_values={"serial_numbers": merged_serials, "quantity": new_quantity, "reason": damage_reason}
                            )
                        else:
                            inventory_manager(
                                product_name=product_name,
                                product_id=product_id,
                                quantity=quantity,
                                model_no=model_no,
                                serial_numbers=fresh_serials,
                                product_type="damaged",
                                reason=damage_reason,
                            ).add(collection_name=INVENTORY_COLLECTION)
                    else:
                        inv_db.restock_returned_units(
                            collection_name=INVENTORY_COLLECTION,
                            product_id=product_id,
                            product_name=product_name,
                            model_no=model_no,
                            quantity=quantity,
                            serial_numbers=fresh_serials,
                        )
                except Exception as ret_err:
                    logging.error(f"order {order_id} return processing failed for {product_id} ({condition}): {ret_err}")
                    raise HTTPException(status_code=400, detail=f"could not process return for {product_name or product_id}: {ret_err}")

                if fresh_serials:
                    newly_processed_serials.extend(fresh_serials)
                else:
                    already_qty[qty_key] = int(already_qty.get(qty_key, 0) or 0) + quantity

                processed_records.append({
                    "product_id": product_id,
                    "product_name": product_name,
                    "model_no": model_no,
                    "condition": condition,
                    "quantity": quantity,
                    "serial_numbers": fresh_serials,
                })

            updated["returned_serials_processed"] = list(already_serials) + newly_processed_serials
            updated["returned_qty_processed"] = already_qty
            # Accumulate across submissions (instead of overwriting) so the
            # order's full return history — every product, its serial(s) and
            # condition — stays visible in View Order Details even if the
            # return was corrected/added-to across more than one submission.
            updated["returned_items"] = list(order.get("returned_items") or []) + processed_records
            logging.info(f"order {order_id} marked returned — {len(returned_items)} item(s) submitted, {len(newly_processed_serials)} new serial(s) processed")

        # These fields actually live inside order["items"][0], not at the
        # top level of the order document — editing them has to go through
        # the item, or they silently land as an unused stray field and the
        # UI never reflects the change.
        item_field_keys = {"product_name", "serial_no", "quantity", "price", "tax_rate"}
        touched_item_fields = item_field_keys & updated.keys()
        # discount lives at the top level already, but total_mrp depends on it too,
        # so a discount-only edit still needs to fall into the recompute branch below
        # instead of leaving a stale total_mrp.
        discount_touched = "discount" in updated

        if "items" in updated:
            # Full multi-item replace from the Edit Order modal — every item
            # in the order can now be edited (qty/price/tax/serials), not
            # just items[0], and each item keeps its own price instead of
            # sharing one combined price across the whole order.
            new_items_raw = updated.pop("items")
            if not new_items_raw:
                raise HTTPException(status_code=400, detail="order must contain at least one product")

            # Reconcile inventory against whatever changed between the old and
            # new item lists — this used to not happen at all: retyping the
            # serial numbers field, or changing quantity, only ever rewrote the
            # order document, so the old serials were never freed back to
            # stock and the new ones were never actually deducted (or even
            # checked for availability). Skipped once the order has already
            # been dispatched — the physical units are gone, so editing the
            # record afterwards shouldn't touch live stock (same guard the
            # cancellation branch above uses).
            old_items = order.get("items", [])

            # Pair each incoming item with the original line it came from,
            # via "original_index" (sent by the Edit Order modal for every
            # row that's still present after the person may have removed
            # some). This replaces a fragile zip(old_items, new_items) that
            # matched purely by POSITION — removing a middle product shifted
            # every item after it by one slot, so the backend thought that
            # product had "changed into" the next one, and the real last
            # item (now past the end of the shorter list) never got its
            # stock/serials restocked at all. Falls back to positional index
            # if a client doesn't send it, so nothing breaks if an older
            # frontend build is still deployed somewhere.
            new_items = []
            kept_indices = set()
            for i, raw in enumerate(new_items_raw):
                item = dict(raw)
                try:
                    orig_idx = int(item.pop("original_index", i))
                except (TypeError, ValueError):
                    orig_idx = i
                kept_indices.add(orig_idx)
                new_items.append((orig_idx, item))

            if not order.get("dispatch"):
                inv_db = inventory_manager()
                # process ALL restocks (freed-up serials/quantity) before ANY
                # deductions, across every line — so a serial number moved
                # from one line to another in the same edit is available
                # again by the time we try to deduct it for its new line,
                # instead of failing with "not available".
                old_lot_map = {x.get("serial_number"): x.get("lot_no", "") for it in old_items for x in (it.get("serial_lots") or [])}
                edit_taken = {}
                restores = []   # (product_id, product_name, model_no, qty, serials)
                deductions = [] # (product_id, product_name, model_no, qty, serials)

                # any old line whose index isn't among the surviving rows was
                # removed entirely in this edit — its full quantity/serials
                # go back to stock, same as a cancellation would do for it.
                for idx, old_item in enumerate(old_items):
                    if idx in kept_indices:
                        continue
                    qty = int(old_item.get("quantity", 0) or 0)
                    if qty <= 0:
                        continue
                    restores.append((
                        old_item.get("product_id", ""),
                        old_item.get("product_name", ""),
                        old_item.get("model_no", "") or "",
                        qty,
                        list(old_item.get("serial_numbers", []) or [])
                    ))

                for orig_idx, new_item in new_items:
                    old_item = old_items[orig_idx] if 0 <= orig_idx < len(old_items) else {}
                    product_id = old_item.get("product_id", new_item.get("product_id", ""))
                    product_name = old_item.get("product_name", new_item.get("product_name", ""))
                    model_no = old_item.get("model_no", new_item.get("model_no", "")) or ""
                    old_serials = set(old_item.get("serial_numbers", []) or [])
                    new_serials = set(new_item.get("serial_numbers", []) or [])
                    old_qty = int(old_item.get("quantity", 0) or 0)
                    new_qty = int(new_item.get("quantity", 0) or 0)

                    removed_serials = list(old_serials - new_serials)
                    added_serials = list(new_serials - old_serials)
                    if removed_serials:
                        restores.append((product_id, product_name, model_no, len(removed_serials), removed_serials))
                    if added_serials:
                        deductions.append((product_id, product_name, model_no, len(added_serials), added_serials))

                    # the portion of quantity NOT backed by a specific serial
                    # (accessories/spare_parts can be stocked with fewer
                    # serials on file than their quantity) — only this part
                    # moves as a plain quantity adjustment; the serialed part
                    # is already handled above via removed/added_serials.
                    old_unserialized = max(0, old_qty - len(old_serials))
                    new_unserialized = max(0, new_qty - len(new_serials))
                    unserialized_delta = new_unserialized - old_unserialized
                    if unserialized_delta > 0:
                        deductions.append((product_id, product_name, model_no, unserialized_delta, []))
                    elif unserialized_delta < 0:
                        restores.append((product_id, product_name, model_no, -unserialized_delta, []))

                for product_id, product_name, model_no, qty, serials in restores:
                    if qty <= 0:
                        continue
                    inv_db.restock_returned_units(
                        collection_name=INVENTORY_COLLECTION,
                        product_id=product_id,
                        product_name=product_name,
                        model_no=model_no,
                        quantity=qty,
                        serial_numbers=serials,
                        serial_lots=[{"serial_number": sn, "lot_no": old_lot_map.get(sn, "")} for sn in serials if old_lot_map.get(sn)],
                    )

                for product_id, product_name, model_no, qty, serials in deductions:
                    if qty <= 0:
                        continue
                    try:
                        if serials:
                            inv_db.allocate_specific_serials(
                                collection_name=INVENTORY_COLLECTION,
                                product_id=product_id,
                                serial_numbers=serials,
                                model_no=model_no or None,
                                product_name=product_name or None,
                            )
                        else:
                            inv_db.allocate_units(
                                collection_name=INVENTORY_COLLECTION,
                                product_id=product_id,
                                quantity=qty,
                                model_no=model_no or None,
                                product_name=product_name or None,
                            )
                    except Exception as e:
                        raise HTTPException(status_code=400, detail=f"{product_name or product_id}: {e}")
                edit_taken.update(inv_db.taken_lots)

            computed_items = []
            for _orig_idx, raw_item in new_items:
                item = dict(raw_item)
                quantity = item.get("quantity", 0)
                price = item.get("price", 0)
                tax_rate = item.get("tax_rate", 0)
                line_amount = price * quantity
                line_tax = line_amount * tax_rate / 100
                item["line_amount"] = line_amount
                item["line_tax"] = line_tax
                item["line_total"] = line_amount + line_tax
                lot_map = {**{x.get("serial_number"): x.get("lot_no", "") for it in old_items for x in (it.get("serial_lots") or [])}, **edit_taken}
                item["serial_lots"] = [{"serial_number": sn, "lot_no": lot_map.get(sn, "")} for sn in (item.get("serial_numbers") or []) if sn]
                computed_items.append(item)

            updated["items"] = computed_items
            discount = updated.get("discount", order.get("discount", 0))
            subtotal = sum(i.get("line_amount", 0) for i in computed_items)
            tax_total = sum(i.get("line_tax", 0) for i in computed_items)
            updated["subtotal"] = subtotal
            updated["tax_total"] = tax_total
            updated["total_mrp"] = subtotal + tax_total - discount

        elif touched_item_fields or discount_touched:
            items = order.get("items", [])
            if not items:
                raise HTTPException(status_code=400, detail="order has no items to edit")
            item = dict(items[0])
            for key in touched_item_fields:
                value = updated.pop(key)
                # the item's actual field is the plural "serial_numbers" list, not "serial_no"
                if key == "serial_no":
                    item["serial_numbers"] = [value] if value else []
                else:
                    item[key] = value

            quantity = item.get("quantity", 0)
            price = item.get("price", 0)
            tax_rate = item.get("tax_rate", 0)
            line_amount = price * quantity
            line_tax = line_amount * tax_rate / 100
            item["line_amount"] = line_amount
            item["line_tax"] = line_tax
            item["line_total"] = line_amount + line_tax

            items = [item] + items[1:]
            updated["items"] = items

            # Recompute order-level totals from the items instead of trusting
            # whatever total_mrp the client sent — the client can't see other
            # items or the discount reliably, so it drifts out of sync.
            discount = updated.get("discount", order.get("discount", 0))
            subtotal = sum(i.get("line_amount", 0) for i in items)
            tax_total = sum(i.get("line_tax", 0) for i in items)
            updated["subtotal"] = subtotal
            updated["tax_total"] = tax_total
            updated["total_mrp"] = subtotal + tax_total - discount

        # company_name / gst_number live under order["customer"], not at the
        # top level either.
        customer_field_keys = {"company_name", "gst_number"}
        touched_customer_fields = customer_field_keys & updated.keys()
        if touched_customer_fields:
            customer = dict(order.get("customer", {}))
            for key in touched_customer_fields:
                customer[key] = updated.pop(key)
            updated["customer"] = customer

        if is_edit:
            history = list(order.get("edit_history", []))
            history.append({
                "edited_by": user["username"],
                "remark": remark,
                "edited_at": datetime.now(timezone.utc).isoformat()
            })
            updated["edit_history"] = history

        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id}, update_values=updated)
        logging.info("order value was updated successfully.")
        return {"message": "order value was updated", "order_id": order_id, "updated_value": updated}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order cannot be updated")
        raise HTTPException(status_code=500, detail="order value cannot be updated")


@app.get("/order/")
def order(user: dict = Depends(get_current_user)):
    try:
        db = order_manager()
        dataset = db.get_data(collection_name=ORDERS_COLLECTION, query={})
        logging.info("order dataset was fetched successfully")
        return {"message": "order dataset", "dataset": dataset}
    except Exception as e:
        logging.error("order dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="order dataset cannot be fetched")


# =========================================================
# SHIPMENT
# =========================================================

def sync_shipment_parts_to_inventory(shipment: dict, received_date: str):
    """
    Push a received shipment's parts into inventory, bucketed by each part's
    status: "assembly" parts -> inventory spare_parts, "purchase" and
    "warranty" parts -> inventory service_parts (kept apart there via
    part_category so the two never merge into one entry). Warranty parts
    also get a warranty_until date computed from this product's warranty
    duration + the shipment's received_date, so inventory can later show
    them as "under warranty" / "over warranty".
    Non-fatal: caller decides what to do if this raises / returns a failure.
    """
    spare_parts_needed = {}      # (product_name, part_name) -> {"quantity": qty, "warranty_until": date|None}
    purchase_parts_needed = {}   # (product_name, part_name) -> total qty
    warranty_parts_needed = {}   # (product_name, part_name) -> {"quantity": qty, "warranty_until": date|None}

    for product in shipment.get("products", []):
        parent_product_name = product.get("product_name", "")
        product_warranty_until = compute_warranty_until(received_date, product.get("warranty", ""))
        for part in product.get("parts", []):
            name = (part.get("part_name") or "").strip()
            qty = part.get("quantity", 0) or 0
            if not name or qty <= 0:
                continue
            status = part.get("status", "assembly")
            key = (parent_product_name, name)

            if status == "assembly":
                entry = spare_parts_needed.setdefault(key, {"quantity": 0, "warranty_until": None})
                entry["quantity"] += qty
                if product_warranty_until and (not entry["warranty_until"] or product_warranty_until > entry["warranty_until"]):
                    entry["warranty_until"] = product_warranty_until
            elif status == "purchase":
                purchase_parts_needed[key] = purchase_parts_needed.get(key, 0) + qty
            else:  # "warranty"
                entry = warranty_parts_needed.setdefault(key, {"quantity": 0, "warranty_until": None})
                entry["quantity"] += qty
                if product_warranty_until and (not entry["warranty_until"] or product_warranty_until > entry["warranty_until"]):
                    entry["warranty_until"] = product_warranty_until

    if not (spare_parts_needed or purchase_parts_needed or warranty_parts_needed):
        return "no_parts"

    inv_db = inventory_manager()
    sync_results = []
    if spare_parts_needed:
        sync_results += inv_db.add_from_shipment_parts(
            collection_name=INVENTORY_COLLECTION,
            parts=[{"part_name": n, "parent_product_name": pn, "quantity": v["quantity"],
                    "warranty_until": v["warranty_until"]}
                   for (pn, n), v in spare_parts_needed.items()],
            product_type="spare_parts",
            supplier=shipment.get("company_name", ""),
            supplier_address=shipment.get("company_address", ""),
            purchase_date=received_date,
            invoice_no=shipment.get("invoice_no", "") or "",
        )
    if purchase_parts_needed:
        sync_results += inv_db.add_from_shipment_parts(
            collection_name=INVENTORY_COLLECTION,
            parts=[{"part_name": n, "parent_product_name": pn, "quantity": q, "part_category": "purchase"}
                   for (pn, n), q in purchase_parts_needed.items()],
            product_type="service_parts",
            supplier=shipment.get("company_name", ""),
            supplier_address=shipment.get("company_address", ""),
            purchase_date=received_date,
            invoice_no=shipment.get("invoice_no", "") or "",
        )
    if warranty_parts_needed:
        sync_results += inv_db.add_from_shipment_parts(
            collection_name=INVENTORY_COLLECTION,
            parts=[{"part_name": n, "parent_product_name": pn, "quantity": v["quantity"], "part_category": "warranty",
                    "warranty_until": v["warranty_until"]}
                   for (pn, n), v in warranty_parts_needed.items()],
            product_type="service_parts",
            supplier=shipment.get("company_name", ""),
            supplier_address=shipment.get("company_address", ""),
            purchase_date=received_date,
            invoice_no=shipment.get("invoice_no", "") or "",
        )
    return sync_results


def _validate_payment(mode, total, paid_amount, credit_days):
    """400s on a bad paid / partial / credit choice (total and paid_amount in the same currency)."""
    mode = (mode or "").strip().lower()
    if mode not in ("paid", "partial", "credit"):
        return
    if mode in ("partial", "credit") and int(credit_days or 0) <= 0:
        raise HTTPException(status_code=400, detail="enter in how many days the remaining payment will be made")
    if mode in ("partial", "credit") and int(credit_days or 0) > 365:
        raise HTTPException(status_code=400, detail="credit days cannot be more than 365")
    if mode == "partial":
        paid = float(paid_amount or 0)
        if paid <= 0:
            raise HTTPException(status_code=400, detail="enter the amount paid now for a partial payment")
        if float(total or 0) > 0 and paid >= float(total):
            raise HTTPException(status_code=400, detail="partial payment must be less than the total - choose Paid instead")


def _purchase_record_payment(mode, amount_inr, paid_inr, credit_days, base_date, old_payments=None):
    """Payment fields stored on a customer["purchases"] row (all INR)."""
    pay = compute_payment(mode, amount_inr, paid_inr, credit_days, base_date)
    return {
        "payment_mode": pay["payment_mode"],
        "paid_amount": pay["paid_amount"],      # paid at purchase time
        "credit_days": pay["credit_days"],
        "due_date": pay["due_date"],
        "payments": list(old_payments or []),   # settlements recorded later from the users page
    }


def _sync_shipment_ledger(shipment: dict, user: dict, contact: dict = None):
    sid = shipment["shipment_id"]
    db = customer_manager()
    old_payments = []     # settlements recorded later must survive a shipment edit
    for c in db.get_data(collection_name=CUSTOMER_COLLECTION, query={}):
        old = c.get("purchases") or []
        kept = [p for p in old if p.get("shipment_id") != sid]
        if len(kept) != len(old):
            for p in old:
                if p.get("shipment_id") == sid:
                    old_payments += list(p.get("payments") or [])
            db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": c["customer_id"]}, update_values={"purchases": kept})
    mode = (shipment.get("payment_mode") or "").lower()
    amount = float(shipment.get("total_inr") or 0)
    name = (shipment.get("company_name") or "").strip()
    if mode not in ("paid", "partial", "credit") or amount <= 0 or not name:
        return None
    rate = float(shipment.get("exchange_rate") or 1)
    paid_inr = round(float(shipment.get("paid_amount") or 0) * rate, 2)
    contact = contact or {}
    rows = db.get_data(collection_name=CUSTOMER_COLLECTION, query={})
    match = next((c for c in rows if shipment.get("customer_id") and c.get("customer_id") == shipment["customer_id"]), None)
    if match is None:
        match = next((c for c in rows if (c.get("company_name") or "").strip().lower() == name.lower()), None)
    if match is None:
        nc = customer_manager(
            company_name=name,
            company_address=shipment.get("company_address", ""),
            gst_number=contact.get("gst_number", ""),
            contractor_person=contact.get("contractor_person", ""),
            contractor_number=contact.get("contractor_number", ""),
            contractor_email=contact.get("contractor_email", ""),
        )
        nc.add(collection_name=CUSTOMER_COLLECTION)
        db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": nc.customer_id},
                       update_values={"credit_limit": 0, "credit_used": 0, "created_by": user["username"]})
        customer_id, purchases = nc.customer_id, []
    else:
        customer_id, purchases = match["customer_id"], list(match.get("purchases") or [])
    products = shipment.get("products") or []
    purchases.append({
        "purchase_id": str(uuid.uuid4()),
        "shipment_id": sid,
        "source": "shipment",
        "date": shipment.get("dispatch_date") or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "product_name": ", ".join(f"{p.get('product_name')} x{p.get('quantity')}" for p in products),
        "quantity": sum(int(p.get("quantity") or 0) for p in products),
        "lot_no": f"Shipment {sid[:8]}",
        "amount": round(amount, 2),
        **_purchase_record_payment(mode, amount, paid_inr, shipment.get("credit_days"),
                                   shipment.get("dispatch_date"), old_payments),
        "currency": shipment.get("currency", "INR"),
        "exchange_rate": shipment.get("exchange_rate", 1),
        "original_amount": shipment.get("total_amount", amount),
        "added_by": user["username"],
        "added_at": datetime.now(timezone.utc).isoformat(),
    })
    db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id}, update_values={"purchases": purchases})
    shipment_manager().update(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": sid}, update_values={"customer_id": customer_id})
    return customer_id


@app.get("/shipment/fx_rate")
def shipment_fx_rate(currency: str, user: dict = Depends(get_current_user)):
    import json
    import urllib.request
    cur = (currency or "").strip().upper()
    if cur == "INR":
        return {"currency": "INR", "rate": 1, "as_of": ""}
    try:
        with urllib.request.urlopen(f"https://open.er-api.com/v6/latest/{cur}", timeout=8) as r:
            data = json.loads(r.read().decode())
        return {"currency": cur, "rate": float(data["rates"]["INR"]), "as_of": data.get("time_last_update_utc", "")}
    except Exception:
        logging.error("fx rate fetch failed")
        raise HTTPException(status_code=502, detail="live exchange rate unavailable, enter the rate manually")


@app.get("/invoice/lookup")
def invoice_lookup(invoice_no: str, user: dict = Depends(require_role("inventory_manager", "admin", "accounts"))):
    inv = (invoice_no or "").strip()
    if not inv:
        return {"found": False}
    pattern = {"$regex": "^" + re.escape(inv) + "$", "$options": "i"}
    try:
        for entry in inventory_manager().get_data(collection_name=INVENTORY_COLLECTION, query={"invoice_no": pattern}):
            if entry.get("supplier"):
                return {"found": True, "source": "inventory", "company_name": entry["supplier"],
                        "company_address": entry.get("supplier_address", "") or ""}
        for ship in shipment_manager().get_data(collection_name=SHIPMENT_COLLECTION, query={"invoice_no": pattern}):
            if ship.get("company_name"):
                return {"found": True, "source": "shipment", "company_name": ship["company_name"],
                        "company_address": ship.get("company_address", "") or ""}
    except Exception as e:
        logging.error(f"invoice lookup failed: {e}")
    return {"found": False}


@app.get("/shipment/")
def shipment(user: dict = Depends(require_role("inventory_manager", "admin", "accounts"))):
    try:
        db = shipment_manager()
        dataset = db.get_data(collection_name=SHIPMENT_COLLECTION, query={})
        logging.info("shipment dataset was fetched successfully")
        return {"message": "shipment dataset", "dataset": dataset}
    except Exception as e:
        logging.error("shipment dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="shipment dataset cannot be fetched")


@app.get("/shipment/{shipment_id}")
def track_shipment(shipment_id: str, user: dict = Depends(require_role("inventory_manager", "admin", "accounts"))):
    try:
        db = shipment_manager()
        result = db.shipment_tracking(collection_name=SHIPMENT_COLLECTION, shipment_id=shipment_id)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment tracking failed!")
        raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")


@app.post("/shipment/create")
def create_shipment(request: CreateShipmentRequest, user: dict = Depends(require_role("inventory_manager", "admin", "accounts"))):
    try:
        _validate_payment(request.payment_mode, sum(float(p.price or 0) * float(p.quantity or 0) for p in request.products),
                          request.paid_amount, request.credit_days)
        shipment_dict = {
            "company_name": request.company_name,
            "company_address": request.company_address,
            "invoice_no": (request.invoice_no or "").strip(),
            "products": [product.dict() for product in request.products],
        }
        shipment_item = shipment_manager(
            company_name=request.company_name,
            company_address=request.company_address,
            invoice_no=request.invoice_no,
            dispatch_date=request.dispatch_date,
            received_date=request.received_date or None,
            products=shipment_dict["products"],
            created_by=user["username"],
            customer_id=request.customer_id,
            payment_mode=request.payment_mode,
            currency=request.currency,
            exchange_rate=request.exchange_rate,
            paid_amount=request.paid_amount,
            credit_days=request.credit_days,
        )
        _, shipment_id = shipment_item.add(collection_name=SHIPMENT_COLLECTION)
        ledger_customer_id = None
        try:
            saved = shipment_item.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})[0]
            ledger_customer_id = _sync_shipment_ledger(saved, user, {
                "gst_number": request.gst_number, "contractor_person": request.contractor_person,
                "contractor_number": request.contractor_number, "contractor_email": request.contractor_email})
        except Exception as led_err:
            logging.error(f"shipment {shipment_id} created but customer ledger sync failed: {led_err}")
        logging.info("shipment created successfully")

        inventory_sync = "skipped"
        # if the received date was already filled in at creation time (the
        # wizard's optional step-1 field), sync parts to inventory right away —
        # otherwise the shipment shows as "received" but never gets the chance
        # to run through mark_shipment_received, and its parts never land in inventory.
        if request.received_date:
            try:
                inventory_sync = sync_shipment_parts_to_inventory(shipment_dict, request.received_date)
            except Exception as inv_err:
                logging.error(f"shipment {shipment_id} created received but parts->inventory sync failed: {inv_err}")
                inventory_sync = f"failed: {inv_err}"

        return {"message": "shipment created successfully", "shipment_id": shipment_id, "inventory_sync": inventory_sync, "customer_id": ledger_customer_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment creation failed!")
        raise HTTPException(status_code=500, detail="shipment creation failed")


@app.post("/shipment/mark_received/{shipment_id}")
def mark_shipment_received(shipment_id: str, request: ShipmentReceivedRequest, user: dict = Depends(require_role("inventory_manager", "admin", "accounts"))):
    try:
        db = shipment_manager()
        existing = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")

        shipment = existing[0]
        db.mark_received(collection_name=SHIPMENT_COLLECTION, shipment_id=shipment_id, received_date=request.received_date)

        # Kept non-fatal: the shipment is already marked received above, so an
        # inventory hiccup here is reported back but doesn't roll that back.
        try:
            inventory_sync = sync_shipment_parts_to_inventory(shipment, request.received_date)
        except Exception as inv_err:
            logging.error(f"shipment {shipment_id} received but parts->inventory sync failed: {inv_err}")
            inventory_sync = f"failed: {inv_err}"

        return {
            "message": "shipment marked as received",
            "shipment_id": shipment_id,
            "received_date": request.received_date,
            "inventory_sync": inventory_sync,
        }

    except HTTPException:
        raise
    except Exception as e:
        logging.error("marking shipment as received failed")
        raise HTTPException(status_code=500, detail="shipment could not be marked as received")


@app.post("/shipment/update/{shipment_id}")
def update_shipment(shipment_id: str, request: ShipmentUpdateRequest, user: dict = Depends(require_role("inventory_manager", "admin", "accounts"))):
    try:
        db = shipment_manager()
        existing = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")

        updated = dict(request.updated_values)
        contact = {k: updated.pop(k, "") for k in ("gst_number", "contractor_person", "contractor_number", "contractor_email")}
        if "currency" in updated:
            updated["currency"] = (updated["currency"] or "INR").upper()
            if updated["currency"] == "INR":
                updated["exchange_rate"] = 1.0
        if updated.get("payment_mode") not in (None, "paid", "partial", "credit"):
            updated["payment_mode"] = "paid"
        merged = {**existing[0], **updated}
        total_amount = sum((float(p.get("price") or 0) * float(p.get("quantity") or 0)) for p in merged.get("products", []))
        updated["total_amount"] = total_amount
        updated["total_inr"] = round(total_amount * float(merged.get("exchange_rate") or 1), 2)
        _validate_payment(merged.get("payment_mode"), total_amount, merged.get("paid_amount"), merged.get("credit_days"))
        pay = compute_payment(merged.get("payment_mode"), total_amount, merged.get("paid_amount"), merged.get("credit_days"),
                              merged.get("dispatch_date"))
        updated.update({"payment_mode": pay["payment_mode"], "paid_amount": pay["paid_amount"],
                        "credit_days": pay["credit_days"], "due_date": pay["due_date"]})
        # keep status in sync if the caller is editing received_date directly
        if "received_date" in updated:
            updated["status"] = "received" if updated["received_date"] else "pending"

        db.update(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id}, update_values=updated)
        logging.info("shipment value was updated successfully.")
        try:
            fresh = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})[0]
            _sync_shipment_ledger(fresh, user, contact)
        except Exception as led_err:
            logging.error(f"shipment {shipment_id} updated but customer ledger sync failed: {led_err}")
        return {"message": "shipment value was updated", "shipment_id": shipment_id, "updated_value": updated}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment cannot be updated")
        raise HTTPException(status_code=500, detail="shipment value cannot be updated")


@app.post("/shipment/delete/{shipment_id}")
def delete_shipment(shipment_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = shipment_manager()
        db.delete(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        try:
            _sync_shipment_ledger({"shipment_id": shipment_id}, user)
        except Exception as led_err:
            logging.error(f"shipment {shipment_id} deleted but customer ledger cleanup failed: {led_err}")
        return {"message": "shipment deleted", "shipment_id": shipment_id}
    except Exception as e:
        logging.error("shipment deletion failed")
        raise HTTPException(status_code=500, detail="shipment deletion failed!")


# =========================================================
# ASSEMBLY
# =========================================================

@app.get("/assembly/")
def assembly(user: dict = Depends(require_role("inventory_manager", "assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        dataset = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={})
        logging.info("assembly dataset was fetched successfully")
        return {"message": "assembly dataset", "dataset": dataset}
    except Exception as e:
        logging.error("assembly dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="assembly dataset cannot be fetched")


def _spare_part_parents() -> dict:
    """part_name -> list of parent product name(s) it is stocked under in inventory spare_parts."""
    parents: dict[str, list] = {}
    for entry in inventory_manager().get_data(collection_name=INVENTORY_COLLECTION, query={"product_type": "spare_parts"}):
        name = entry.get("product_name", "")
        pn = (entry.get("parent_product_name") or "").strip()
        if name and pn and pn not in parents.setdefault(name, []):
            parents[name].append(pn)
    return parents


def _fill_belongs_to(parts: list, strict: bool = True) -> list:
    """
    Inventory parts are identified by part_name + belongs_to. If belongs_to is missing
    and the part is stocked under exactly one product, it is filled in. If it is stocked
    under several products the caller must say which one (strict -> 400; otherwise skipped,
    used for legacy records). Local parts keep whatever was typed.
    """
    parents = _spare_part_parents()
    for p in parts:
        p["belongs_to"] = (p.get("belongs_to") or "").strip()
        if p.get("source", "inventory") == "local" or p["belongs_to"]:
            continue
        options = parents.get(p.get("part_name", ""), [])
        if len(options) == 1:
            p["belongs_to"] = options[0]
        elif len(options) > 1 and strict:
            raise HTTPException(
                status_code=400,
                detail=f"'{p.get('part_name')}' is stocked under several products ({', '.join(options)}) — choose which product it belongs to",
            )
    return parts


@app.get("/assembly/available_parts")
def available_parts_for_assembly(user: dict = Depends(require_role("inventory_manager", "assembly", "admin", "accounts"))):
    """
    Spare parts currently sitting in inventory — the pool an assembly's parts
    are pulled from. This stock is fed by shipments: a shipment part marked
    "assembly" lands in inventory as product_type="spare_parts" as soon as
    the shipment is marked received (see mark_shipment_received above).

    Only parts that already carry hologram numbers are surfaced here — each
    assembled unit needs one, so a part with none on file can't be used to
    build one. "hologram_available" tells the UI how many units of this part
    can actually be assembled (which may be less than raw quantity, if only
    some units have had a hologram number added yet).
    """
    try:
        inv_db = inventory_manager()
        dataset = inv_db.get_data(collection_name=INVENTORY_COLLECTION, query={"product_type": "spare_parts"})

        pool = {}
        for entry in dataset:
            name = entry.get("product_name", "")
            qty = int(entry.get("quantity", 0) or 0)
            hologram_count = len(entry.get("hologram_numbers") or [])
            if not name or qty <= 0 or hologram_count <= 0:
                continue
            pn = (entry.get("parent_product_name") or "").strip()
            agg = pool.setdefault((name, pn), {"quantity": 0, "hologram_available": 0})
            agg["quantity"] += qty
            agg["hologram_available"] += hologram_count

        available = [
            {"part_name": name, "quantity": v["quantity"], "hologram_available": v["hologram_available"],
             "belongs_to": pn}
            for (name, pn), v in sorted(pool.items(), key=lambda kv: (kv[0][0].lower(), kv[0][1].lower()))
        ]
        return {"message": "available parts", "dataset": available}
    except Exception as e:
        logging.error("available parts for assembly cannot be fetched")
        raise HTTPException(status_code=500, detail="available parts cannot be fetched")


@app.get("/assembly/{assembly_id}")
def track_assembly(assembly_id: str, user: dict = Depends(require_role("inventory_manager", "assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        result = db.assembly_tracking(collection_name=ASSEMBLY_COLLECTION, assembly_id=assembly_id)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly tracking failed!")
        raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")


@app.post("/assembly/create")
def create_assembly(request: CreateAssemblyRequest, user: dict = Depends(require_role("inventory_manager", "assembly", "admin", "accounts"))):
    try:
        parts_used = _fill_belongs_to([part.dict() for part in request.parts_used])

        if len(request.serials) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match the assembly quantity")
        serial_values = [s.serial_number.strip() for s in request.serials]
        if any(not s for s in serial_values):
            raise HTTPException(status_code=400, detail="every unit needs a serial number")
        if len(set(serial_values)) != len(serial_values):
            raise HTTPException(status_code=400, detail="serial numbers must be unique within this batch")
        # lot number is compulsory for every unit — but no guard on its value: one assembly can
        # have several different lot numbers and the same lot can repeat across units
        lot_values = [(s.lot_no or "").strip() for s in request.serials]
        if any(not l for l in lot_values):
            raise HTTPException(status_code=400, detail="every unit needs a lot number")

        # sum up everything sourced from inventory, merging duplicate part names
        needed_from_inventory: dict[tuple, int] = {}   # (part_name, belongs_to) -> qty
        for p in parts_used:
            if p["source"] != "inventory" or p["quantity"] <= 0:
                continue
            k = (p["part_name"], p.get("belongs_to", ""))
            needed_from_inventory[k] = needed_from_inventory.get(k, 0) + p["quantity"]

        if not needed_from_inventory:
            raise HTTPException(
                status_code=400,
                detail="add at least one part from inventory — its hologram numbers supply the assembled units' hologram numbers",
            )

        # at least one inventory part must have enough quantity at a 1:1 ratio
        # with the assembly quantity — that's the hologram-bearing part, and its
        # hologram numbers (one per unit) become each finished unit's hologram
        # number. If more than one part qualifies, that's not an error — extra
        # (zyada) is fine, we just pick one; only a shortage (kam) blocks.
        hologram_candidates = [name for name, qty in needed_from_inventory.items() if qty >= request.quantity]
        if not hologram_candidates:
            raise HTTPException(
                status_code=400,
                detail="at least one part from inventory must have quantity at least equal to the assembly quantity — "
                       "that part supplies the hologram number for each assembled unit",
            )
        # pick the first qualifying part (in the order it was entered) as the
        # hologram-bearing part
        hologram_key = hologram_candidates[0]          # (part_name, belongs_to)
        hologram_part_name = hologram_key[0]

        # how much of each inventory part actually gets consumed: the hologram
        # part only gives up exactly `request.quantity` (one per unit) — any
        # extra the user entered for it stays untouched in inventory. Every
        # other part is consumed at the full quantity entered for it.
        consume_amounts = {
            key: (request.quantity if key == hologram_key else qty)
            for key, qty in needed_from_inventory.items()
        }

        inv_db = inventory_manager()

        # validate stock (and, for the hologram part, hologram numbers on file) is
        # sufficient for EVERY part before deducting any of them — otherwise a
        # shortage on part #2 would leave part #1 already (irreversibly) deducted
        for (part_name, belongs), qty in consume_amounts.items():
            have = inv_db.get_available_quantity_by_name(
                collection_name=INVENTORY_COLLECTION, product_name=part_name, product_type="spare_parts",
                parent_product_name=belongs or None,
            )
            if have < qty:
                raise HTTPException(
                    status_code=400,
                    detail=f"not enough '{part_name}'{' (' + belongs + ')' if belongs else ''} in inventory spare parts (need {qty}, have {have})",
                )
            if (part_name, belongs) == hologram_key:
                hologram_have = inv_db.get_hologram_available_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name, product_type="spare_parts",
                    parent_product_name=belongs or None,
                )
                if hologram_have < request.quantity:
                    raise HTTPException(
                        status_code=400,
                        detail=f"not enough hologram-tagged '{part_name}'{' (' + belongs + ')' if belongs else ''} in inventory (need {request.quantity}, have {hologram_have})",
                    )

        # stock confirmed for every part — now actually deduct
        hologram_numbers: list[str] = []
        part_lots: dict = {}
        for (part_name, belongs), qty in consume_amounts.items():
            part_lots[(part_name, belongs)] = []
            if (part_name, belongs) == hologram_key:
                hologram_numbers = inv_db.allocate_hologram_numbers_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name,
                    product_type="spare_parts", quantity=request.quantity,
                    parent_product_name=belongs or None, collect=part_lots[(part_name, belongs)],
                )
                # any quantity beyond one-per-unit is left untouched in
                # inventory — we only take what's needed
            else:
                inv_db.consume_quantity(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name,
                    product_type="spare_parts", quantity=qty,
                    parent_product_name=belongs or None, collect=part_lots[(part_name, belongs)],
                )

        if len(hologram_numbers) != request.quantity:
            raise HTTPException(status_code=500, detail="could not allocate a hologram number for every assembled unit")

        serials = [
            {"serial_number": s.serial_number.strip(), "hologram_number": hologram_numbers[i], "lot_no": lot_values[i]}
            for i, s in enumerate(request.serials)
        ]

        assembly_item = assembly_manager(
            product_name=request.product_name,
            product_id=request.product_id,
            model_number=request.model_number,
            quantity=request.quantity,
            parts_used=parts_used,
            serials=serials,
            created_by=user["username"],
            hologram_part=hologram_part_name,
            hologram_part_belongs_to=hologram_key[1],
        )
        _, assembly_id = assembly_item.add(collection_name=ASSEMBLY_COLLECTION)
        try:
            assembly_manager().update(
                collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id},
                update_values={"part_sources": [{"part_name": k[0], "belongs_to": k[1], "lots": v} for k, v in part_lots.items()]})
        except Exception as src_err:
            logging.error(f"assembly {assembly_id} created but part sources could not be saved: {src_err}")
        logging.info("assembly created successfully")
        return {"message": "assembly created successfully", "assembly_id": assembly_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly creation failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/assembly/mark_completed/{assembly_id}")
def mark_assembly_completed(assembly_id: str, user: dict = Depends(require_role("inventory_manager", "assembly", "admin", "accounts"))):
    """Assembly team submits the batch for approval. Nothing goes to inventory yet."""
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")
        if existing[0].get("status") != "pending":
            raise HTTPException(status_code=400, detail="only a pending assembly can be submitted for approval")

        db.update(
            collection_name=ASSEMBLY_COLLECTION,
            query={"assembly_id": assembly_id},
            update_values={
                "status": "pending_approval",
                "approved_serials": [],
                "submitted_by": user.get("username"),
                "submitted_at": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {"message": "assembly submitted for approval", "assembly_id": assembly_id, "status": "pending_approval"}
    except HTTPException:
        raise
    except Exception:
        logging.error("submitting assembly for approval failed")
        raise HTTPException(status_code=500, detail="assembly could not be submitted for approval")


@app.post("/assembly/approve/{assembly_id}")
def approve_assembly(assembly_id: str, request: ApproveAssemblyRequest, user: dict = Depends(require_role("admin", "accounts"))):
    """
    Approver ticks the serial numbers that physically arrived. Only those units
    are added to inventory. All serials approved -> "completed"; some -> "partially_approved".
    """
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")
        assembly = existing[0]
        if assembly.get("status") not in ("pending_approval", "partially_approved"):
            raise HTTPException(status_code=400, detail="this assembly is not awaiting approval")

        all_serials = [s.get("serial_number") for s in assembly.get("serials", []) if s.get("serial_number")]
        already = set(assembly.get("approved_serials") or [])
        requested = list(dict.fromkeys(request.serial_numbers))
        unknown = [x for x in requested if x not in all_serials]
        if unknown:
            raise HTTPException(status_code=400, detail=f"serial(s) not part of this assembly: {', '.join(unknown)}")
        new_serials = [x for x in requested if x not in already]
        if not new_serials:
            raise HTTPException(status_code=400, detail="select at least one serial number that is not approved yet")

        # a unit's serial must never enter inventory twice
        _assert_unique_product_serials(new_serials)

        # inventory first - if this fails nothing is marked approved
        inv_db = inventory_manager()
        sync_result = inv_db.add_from_assembly(
            collection_name=INVENTORY_COLLECTION,
            product_name=assembly.get("product_name"),
            product_id=assembly.get("product_id"),
            model_no=assembly.get("model_number"),
            quantity=len(new_serials),
            serial_numbers=new_serials,
            purchase_date=datetime.now(timezone.utc).date().isoformat(),
            # the same lot numbers entered in the assembly go into inventory with their units
            serial_lots=[{"serial_number": sv.get("serial_number"), "lot_no": sv.get("lot_no", "")}
                         for sv in assembly.get("serials", []) if sv.get("serial_number") in set(new_serials)],
        )

        approved_all = list(already) + new_serials
        status = "completed" if len(set(approved_all)) >= len(set(all_serials)) else "partially_approved"
        history = (assembly.get("approval_history") or []) + [{
            "approved_by": user.get("username"),
            "approved_at": datetime.now(timezone.utc).isoformat(),
            "serials": new_serials,
        }]
        db.update(
            collection_name=ASSEMBLY_COLLECTION,
            query={"assembly_id": assembly_id},
            update_values={"status": status, "approved_serials": approved_all, "approval_history": history},
        )
        return {
            "message": "assembly approved" if status == "completed" else "assembly partially approved",
            "assembly_id": assembly_id,
            "status": status,
            "approved_serials": approved_all,
            "added_to_inventory": len(new_serials),
            "inventory_sync": sync_result["mode"],
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"assembly approval failed: {e}")
        raise HTTPException(status_code=500, detail="assembly could not be approved")


@app.post("/assembly/update/{assembly_id}")
def update_assembly(assembly_id: str, request: AssemblyUpdateRequest, user: dict = Depends(require_role("inventory_manager", "assembly", "admin", "accounts"))):
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")

        updated = dict(request.updated_values)
        db.update(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id}, update_values=updated)
        logging.info("assembly value was updated successfully.")
        return {"message": "assembly value was updated", "assembly_id": assembly_id, "updated_value": updated}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly cannot be updated")
        raise HTTPException(status_code=500, detail="assembly value cannot be updated")


def _inventory_needed(parts_used: list) -> dict:
    """Sums the quantity of every inventory-sourced part by (part_name, belongs_to) — local parts never touch inventory."""
    needed: dict[tuple, int] = {}
    for p in parts_used or []:
        qty = int(p.get("quantity", 0) or 0)
        if p.get("source", "inventory") != "inventory" or qty <= 0:
            continue
        k = (p["part_name"], p.get("belongs_to", "") or "")
        needed[k] = needed.get(k, 0) + qty
    return needed


@app.post("/assembly/edit/{assembly_id}")
def edit_assembly(assembly_id: str, request: EditAssemblyRequest, user: dict = Depends(require_role("inventory_manager", "admin", "assembly"))):
    """
    Edit a PENDING assembly while it is still being built — parts can be added,
    removed or their quantity changed. Only admin and assembly users may do this.

    Inventory follows the change automatically:
      - a part's inventory consumption went UP   -> the extra is deducted from spare_parts stock
      - a part's inventory consumption went DOWN -> the difference is restocked into spare_parts
      - a part removed / switched to local       -> its whole consumption is restocked
      - a part added from inventory              -> deducted
    The hologram-bearing part always consumes exactly `quantity` (one per unit),
    so it must stay at or above `quantity` and its extra listed quantity never
    moves stock. Serial / hologram numbers and the unit quantity are not editable here.
    """
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")
        assembly = existing[0]

        if assembly.get("status") != "pending":
            raise HTTPException(
                status_code=400,
                detail="only pending assemblies can be edited — a completed assembly's units are already in inventory",
            )

        quantity = int(assembly.get("quantity", 0) or 0)
        new_parts = assembly_manager._normalize_parts_used(_fill_belongs_to([p.dict() for p in request.parts_used]))
        old_parts = _fill_belongs_to([dict(p) for p in assembly.get("parts_used", [])], strict=False)   # legacy records
        if any(int(p["quantity"]) < 0 for p in new_parts):
            raise HTTPException(status_code=400, detail="part quantity cannot be negative")

        old_needed = _inventory_needed(old_parts)
        new_needed = _inventory_needed(new_parts)

        # the part that supplied the hologram numbers when the assembly was created
        # (older records without the field: same rule create uses — first part in
        # entered order whose quantity reached the assembly quantity)
        h_name = assembly.get("hologram_part")
        if h_name:
            h_belongs = assembly.get("hologram_part_belongs_to", "") or ""
            hologram_part = (h_name, h_belongs)
            if hologram_part not in old_needed:      # legacy record: match by name only
                hologram_part = next((k for k in old_needed if k[0] == h_name), hologram_part)
        else:
            hologram_part = next((k for k, qty in old_needed.items() if qty >= quantity), None)
        if not hologram_part:
            raise HTTPException(status_code=400, detail="this assembly has no hologram-bearing part on record, so it cannot be edited")
        if new_needed.get(hologram_part, 0) < quantity:
            raise HTTPException(
                status_code=400,
                detail=f"'{hologram_part[0]}'{' (' + hologram_part[1] + ')' if hologram_part[1] else ''} supplies the hologram numbers, so its inventory quantity must stay at least {quantity}",
            )

        # what each inventory part actually consumes (hologram part: exactly one per unit)
        old_consume = {n: (quantity if n == hologram_part else q) for n, q in old_needed.items()}
        new_consume = {n: (quantity if n == hologram_part else q) for n, q in new_needed.items()}
        deltas = {}
        for name in set(old_consume) | set(new_consume):
            diff = new_consume.get(name, 0) - old_consume.get(name, 0)
            if diff != 0:
                deltas[name] = diff      # + = deduct more, - = restock

        inv_db = inventory_manager()

        # check stock for every increase BEFORE touching anything
        for name, diff in deltas.items():
            if diff > 0:
                have = inv_db.get_available_quantity_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=name[0], product_type="spare_parts",
                    parent_product_name=name[1] or None,
                )
                if have < diff:
                    raise HTTPException(
                        status_code=400,
                        detail=f"not enough '{name[0]}'{' (' + name[1] + ')' if name[1] else ''} in inventory spare parts (need {diff} more, have {have})",
                    )

        applied = []      # (name, diff) already pushed to inventory, for rollback
        extra_lots: dict = {}

        def _rollback():
            for r_name, r_diff in reversed(applied):
                try:
                    if r_diff > 0:
                        inv_db.restock_quantity(collection_name=INVENTORY_COLLECTION, product_name=r_name[0],
                                                product_type="spare_parts", quantity=r_diff, updated_by=user["username"],
                                                parent_product_name=r_name[1] or None)
                    else:
                        inv_db.consume_quantity(collection_name=INVENTORY_COLLECTION, product_name=r_name[0],
                                                product_type="spare_parts", quantity=-r_diff,
                                                parent_product_name=r_name[1] or None)
                except Exception as rb_err:
                    logging.error(f"assembly edit rollback failed for '{r_name}': {rb_err}")

        try:
            for name, diff in deltas.items():
                if diff > 0:
                    extra_lots[name] = []
                    inv_db.consume_quantity(collection_name=INVENTORY_COLLECTION, product_name=name[0],
                                            product_type="spare_parts", quantity=diff,
                                            parent_product_name=name[1] or None, collect=extra_lots[name])
                    applied.append((name, diff))
            for name, diff in deltas.items():
                if diff < 0:
                    inv_db.restock_quantity(collection_name=INVENTORY_COLLECTION, product_name=name[0],
                                            product_type="spare_parts", quantity=-diff, updated_by=user["username"],
                                            parent_product_name=name[1] or None)
                    applied.append((name, diff))

            inventory_changes = [
                {"part_name": name[0], "belongs_to": name[1], "action": "deducted" if diff > 0 else "restocked", "quantity": abs(diff)}
                for name, diff in deltas.items()
            ]
            now = datetime.now(timezone.utc).isoformat()
            update_values = {
                "parts_used": new_parts,
                "hologram_part": hologram_part[0],
                "hologram_part_belongs_to": hologram_part[1],
                "updated_by": user["username"],
                "updated_at": now,
                "edit_history": list(assembly.get("edit_history") or []) + [{
                    "edited_by": user["username"],
                    "edited_at": now,
                    "previous_parts_used": assembly.get("parts_used", []),
                    "inventory_changes": inventory_changes,
                }],
            }
            if extra_lots:
                sources = [dict(s, lots=list(s.get("lots") or [])) for s in (assembly.get("part_sources") or [])]
                for key, lots in extra_lots.items():
                    hit = next((s for s in sources if s.get("part_name") == key[0] and (s.get("belongs_to") or "") == (key[1] or "")), None)
                    if hit is None:
                        hit = {"part_name": key[0], "belongs_to": key[1], "lots": []}
                        sources.append(hit)
                    hit["lots"].extend(lots)
                update_values["part_sources"] = sources
            for field, value in (("product_name", request.product_name),
                                 ("product_id", request.product_id),
                                 ("model_number", request.model_number)):
                if value is not None:
                    value = value.strip()
                    if field == "product_name" and not value:
                        raise HTTPException(status_code=400, detail="product name cannot be empty")
                    update_values[field] = value

            db.update(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id}, update_values=update_values)
        except Exception:
            _rollback()
            raise

        logging.info(f"assembly {assembly_id} edited by {user['username']}")
        return {"message": "assembly updated", "assembly_id": assembly_id, "inventory_changes": inventory_changes}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly edit failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/assembly/delete/{assembly_id}")
def delete_assembly(assembly_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = assembly_manager()
        db.delete(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        return {"message": "assembly deleted", "assembly_id": assembly_id}
    except Exception as e:
        logging.error("assembly deletion failed")
        raise HTTPException(status_code=500, detail="assembly deletion failed!")


DISPATCH_MEDIA_STALE_DAYS = int(os.getenv("DISPATCH_MEDIA_STALE_DAYS", "5"))


class DamageReportRequest(BaseModel):
    issue: str
    image: str  # base64 data URL - required, enforced below


def send_damage_report_email(allocation_id: str, product_label: str, issue: str, image_data_url: str, reported_by: str):
    """
    Emails the damage photo + issue description to GMAIL_NOTIFY_RECEIVER right
    away, before the image gets purged from Mongo. Never raises - a failed
    email should not block the damage report from being saved.
    """
    if not GMAIL_SENDER_EMAIL or not GMAIL_SENDER_APP_PASSWORD or not GMAIL_NOTIFY_RECEIVER:
        logging.error("gmail credentials not configured - skipping damage report email")
        return False
    try:
        msg = EmailMessage()
        msg["Subject"] = f"Damaged product reported - allocation {allocation_id[:8]}"
        msg["From"] = GMAIL_SENDER_EMAIL
        msg["To"] = GMAIL_NOTIFY_RECEIVER
        msg.set_content(
            f"Allocation ID: {allocation_id}\n"
            f"Product: {product_label}\n"
            f"Reported by: {reported_by}\n"
            f"Reported at: {datetime.now(timezone.utc).isoformat()}\n\n"
            f"Issue:\n{issue}\n\n"
            f"(Photo attached. This image will be deleted from the database "
            f"{DAMAGE_IMAGE_RETENTION_DAYS} day(s) after being reported.)"
        )

        if image_data_url.startswith("data:"):
            header, b64data = image_data_url.split(",", 1)
            mime = header.split(":")[1].split(";")[0]  # e.g. image/jpeg
            subtype = mime.split("/")[1] if "/" in mime else "jpeg"
            img_bytes = base64.b64decode(b64data)
            msg.add_attachment(img_bytes, maintype="image", subtype=subtype, filename=f"damage_{allocation_id[:8]}.{subtype}")

        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
            smtp.login(GMAIL_SENDER_EMAIL, GMAIL_SENDER_APP_PASSWORD)
            smtp.send_message(msg)

        logging.info(f"damage report email sent for allocation {allocation_id}")
        return True
    except Exception as e:
        logging.error(f"failed to send damage report email for allocation {allocation_id}: {e}")
        return False


# ---------- performance helpers ----------
_bg_lock = threading.Lock()
_bg_last = {}
_bg_running = set()


def run_in_background(name: str, fn, min_interval: int = 1800):
    """Runs housekeeping jobs (image purge / Drive migration) off the request path, at most once
    per `min_interval` seconds and never two copies at once, so page loads no longer wait for them."""
    now = time.time()
    with _bg_lock:
        if name in _bg_running or now - _bg_last.get(name, 0) < min_interval:
            return
        _bg_running.add(name)
        _bg_last[name] = now

    def _job():
        try:
            fn()
        except Exception as e:
            logging.error(f"background job {name} failed: {e}")
        finally:
            with _bg_lock:
                _bg_running.discard(name)

    threading.Thread(target=_job, daemon=True).start()


def ensure_indexes():
    """Idempotent — creates indexes on the fields the list/lookup queries filter by."""
    wanted = {
        ALLOCATION_COLLECTION: ["allocation_id", "allocated_by", "allocation_type", "return_status"],
        ORDERS_COLLECTION: ["order_id", "status", "creator.raised_by"],
        REQUESTS_COLLECTION: ["request_id", "raised_by", "status"],
        INVENTORY_COLLECTION: ["product_id", "product_type"],
        ACCOUNTS_COLLECTION: ["username", "role"],
        CUSTOMER_COLLECTION: ["customer_id"],
        SERVICE_COLLECTION: ["service_id"],
        INSTALLATION_COLLECTION: ["installation_id", "technician_id", "status"],
    }
    db = mongodbclient().database
    for coll, fields in wanted.items():
        for field in fields:
            try:
                db[coll].create_index(field, background=True)
            except Exception as e:
                logging.error(f"index {coll}.{field} skipped: {e}")


def _warm_up_db():
    """Opens the first DB connection at startup so the first page load doesn't pay for it."""
    try:
        t = time.perf_counter()
        mongodbclient().client.admin.command("ping")
        logging.info(f"mongodb warm-up ping took {(time.perf_counter() - t) * 1000:.0f} ms")
    except Exception as e:
        logging.error(f"mongodb warm-up failed: {e}")
    ensure_indexes()


@app.on_event("startup")
def _create_indexes_on_startup():
    threading.Thread(target=_warm_up_db, daemon=True).start()
    threading.Thread(target=_reminder_loop, daemon=True).start()


def purge_stale_damage_images():
    """
    Finds damage reports whose image is still stored and is older than
    DAMAGE_IMAGE_RETENTION_DAYS, then clears just the image field (issue text
    and metadata are kept). Runs automatically whenever allocations are
    loaded. Never raises - a hiccup here should not break the page.
    """
    try:
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=DAMAGE_IMAGE_RETENTION_DAYS)).isoformat()
        stale_query = {
            "damage_report.reported_at": {"$ne": None, "$lt": cutoff_iso},
            "damage_report.image": {"$ne": None}
        }
        db = mongodbclient()
        stale_docs = db.get_data(collection_name=ALLOCATION_COLLECTION, query=stale_query)
        purged_count = 0
        for doc in stale_docs:
            allocation_id = doc.get("allocation_id")
            db.update_data(
                collection_name=ALLOCATION_COLLECTION,
                query={"allocation_id": allocation_id},
                update_values={"damage_report.image": None, "damage_report.image_purged": True}
            )
            purged_count += 1
        if purged_count:
            logging.info(f"purged {purged_count} stale damage report image(s)")
        return purged_count
    except Exception as e:
        logging.error(f"stale damage image purge skipped due to error: {e}")
        return 0


def migrate_stale_dispatch_media():
    """
    Same idea as service_detail.migrate_stale_media(), applied to the
    "dispatch" sub-document embedded on orders and spare-part allocations:
    finds dispatch records whose image is still a raw base64 blob and is
    older than DISPATCH_MEDIA_STALE_DAYS (default 5 days), uploads it to
    Google Drive, and replaces the field in Mongo with a placeholder +
    the Drive link. Runs automatically on every dispatch queue load. Never
    raises - a Drive/network hiccup should not break the page.
    """
    try:
        cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=DISPATCH_MEDIA_STALE_DAYS)).isoformat()
        stale_query = {
            "dispatch.media_updated_at": {"$ne": None, "$lt": cutoff_iso},
            "dispatch.image": {"$regex": "^data:"}
        }

        migrated_count = 0
        for collection_name, id_field in ((ORDERS_COLLECTION, "order_id"), (ALLOCATION_COLLECTION, "allocation_id")):
            db = mongodbclient()
            stale_docs = db.get_data(collection_name=collection_name, query=stale_query)
            for doc in stale_docs:
                record_id = doc.get(id_field)
                image_val = (doc.get("dispatch") or {}).get("image") or ""
                if not image_val.startswith("data:"):
                    continue
                try:
                    link = upload_base64_to_drive(image_val, filename=f"dispatch_{record_id}_image")
                    db.update_data(
                        collection_name=collection_name,
                        query={id_field: record_id},
                        update_values={"dispatch.image": GDRIVE_PLACEHOLDER, "dispatch.image_drive_link": link}
                    )
                    migrated_count += 1
                except Exception as media_err:
                    logging.error(f"failed to migrate dispatch image for {id_field} {record_id}: {media_err}")

        if migrated_count:
            logging.info(f"migrated dispatch images to Google Drive for {migrated_count} record(s)")
        return migrated_count
    except Exception as e:
        logging.error(f"stale dispatch media migration skipped due to error: {e}")
        return 0


@app.get("/dispatch/")
def dispatch_queue(user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        run_in_background("migrate_dispatch_media", migrate_stale_dispatch_media, 600)
        odb = order_manager()
        # dispatched orders must stay in this queue's dispatched list even after they are marked
        # "delivered", so fetch all three statuses
        all_orders = odb.get_data(collection_name=ORDERS_COLLECTION, query={"status": {"$in": ["processing", "dispatched", "delivered"]}})
        pending_orders = [o for o in all_orders if o.get("status") == "processing" and not o.get("dispatch")]

        adb = allocation_manager()
        all_spare = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_type": "spare_part"})
        pending_spare = [a for a in all_spare if not a.get("dispatch")]

        all_alloc = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={})
        all_product_alloc = [a for a in all_alloc if a.get("allocation_type") != "spare_part" and a.get("sent_to_dispatch")]
        pending_product_alloc = [a for a in all_product_alloc if not a.get("dispatch")]

        pending_services, dispatched_services = [], []
        try:
            for sv in service_detail(product_id="", serial_no="").get_data(collection_name=SERVICE_COLLECTION, query={"status": "completed"}, projection={"image": 0, "video": 0}):
                sv.pop("_id", None)
                sv["allocation_id"] = sv.get("service_id")
                sv["items"] = [{"product_id": sv.get("product_id"), "product_name": sv.get("product_name"), "model_no": sv.get("model_no"),
                                "quantity": 1, "serial_numbers": [sv["serial_no"]] if sv.get("serial_no") else []}]
                (dispatched_services if sv.get("dispatch") else pending_services).append(sv)
        except Exception:
            logging.error("completed services could not be added to the dispatch queue")

        dispatched_orders = [o for o in all_orders if o.get("dispatch")]
        dispatched_spare = [a for a in all_spare if a.get("dispatch")]
        dispatched_product_alloc = [a for a in all_product_alloc if a.get("dispatch")]

        # Manufacturing date on the dispatch form = assembling date of each serial number.
        # Serials that were never assembled in-house simply get no date.
        assembly_dates = {}
        try:
            serial_nos = {sn for rec in (all_orders + all_product_alloc)
                          for it in (rec.get("items") or []) for sn in (it.get("serial_numbers") or []) if sn}
            if serial_nos:
                for asm in assembly_manager().get_data(collection_name=ASSEMBLY_COLLECTION,
                                                       query={"serials.serial_number": {"$in": list(serial_nos)}}):
                    when = asm.get("completed_at") or asm.get("assembly_date") or asm.get("created_at")
                    if not when:
                        continue
                    for s in asm.get("serials", []):
                        if s.get("serial_number") in serial_nos:
                            assembly_dates[s["serial_number"]] = when
        except Exception:
            logging.error("assembly dates for the dispatch form could not be fetched")

        logging.info("dispatch queue was fetched successfully")
        return {
            "message": "dispatch queue",
            "pending_orders": pending_orders,
            "pending_spare_parts": pending_spare,
            "pending_product_allocations": pending_product_alloc,
            "dispatched_orders": dispatched_orders,
            "dispatched_spare_parts": dispatched_spare,
            "dispatched_product_allocations": dispatched_product_alloc,
            "pending_services": pending_services,
            "dispatched_services": dispatched_services,
            "assembly_dates": assembly_dates
        }
    except Exception as e:
        logging.error("dispatch queue could not be fetched")
        raise HTTPException(status_code=500, detail="dispatch queue could not be fetched")


# =========================================================
# Attendance — daily biometric upload, monthly report, and
# automatic WhatsApp "you are late" reminders via Twilio.
# Admin-only end to end (see require_role("admin") below and
# common_auth.js's ROLE_ACCESS for the page itself).
# =========================================================

class _AttendanceTableParser(HTMLParser):
    """
    Minimal dependency-free <table> reader (stdlib html.parser only — no
    lxml/html5lib needed, unlike pandas.read_html which requires one of
    those and silently fails on servers that don't have them installed).
    Reads every <tr>, and within it every <td>/<th> cell's text, into a
    plain list of rows — exactly what the biometric machine's "Daily
    Present List" export needs (it's an HTML table saved with a .xls
    extension).
    """
    def __init__(self):
        super().__init__()
        self.rows = []
        self._current_row = None
        self._current_cell = None
        self._in_cell = False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._current_row = []
        elif tag in ("td", "th"):
            self._in_cell = True
            self._current_cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            if self._current_row is not None:
                self._current_row.append("".join(self._current_cell).strip())
            self._in_cell = False
            self._current_cell = None
        elif tag == "tr":
            if self._current_row is not None:
                self.rows.append(self._current_row)
            self._current_row = None

    def handle_data(self, data):
        if self._in_cell and self._current_cell is not None:
            self._current_cell.append(data)


def parse_attendance_table(html_text: str):
    parser = _AttendanceTableParser()
    parser.feed(html_text)
    return [r for r in parser.rows if any((c or "").strip() for c in r)]


def get_late_threshold() -> str:
    db = mongodbclient()
    doc = db.get_data(collection_name=ATTENDANCE_SETTINGS_COLLECTION, query={"key": "late_threshold"})
    return doc[0].get("value", "10:00") if doc else "10:00"


def find_employee_phone(db, employee_name: str) -> Optional[str]:
    """
    Looks up an employee's WhatsApp/mobile number from the single accounts
    (user) collection instead of a separate contacts list. Matches the
    biometric device's "Employee Name" against each account's "name" field
    case-insensitively (device exports and account records don't always
    agree on capitalization), so "Rahul Sharma", "RAHUL SHARMA" and
    "rahul sharma" are all treated as the same person.
    """
    name = (employee_name or "").strip()
    if not name:
        return None
    match = db.get_data(
        collection_name=ACCOUNTS_COLLECTION,
        query={"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
    )
    return match[0].get("phone") if match else None


def send_whatsapp_late_reminder(phone_number: str, employee_name: str, in_time: str) -> bool:
    """
    Sends a "you are late today" WhatsApp message via Twilio.
    Requires the `twilio` package (pip install twilio) and these env vars:
      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
      (TWILIO_WHATSAPP_FROM looks like "whatsapp:+14155238886")
    Silently returns False (and logs why) if any of that isn't set up yet,
    so a missing Twilio config never blocks the attendance upload itself.
    """
    if TwilioClient is None:
        logging.error("twilio package not installed — run `pip install twilio` to enable late reminders")
        return False
    sid = os.getenv("TWILIO_ACCOUNT_SID")
    token = os.getenv("TWILIO_AUTH_TOKEN")
    from_whatsapp = os.getenv("TWILIO_WHATSAPP_FROM")
    if not (sid and token and from_whatsapp):
        logging.error("Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM")
        return False
    try:
        client = TwilioClient(sid, token)
        to = phone_number if phone_number.startswith("whatsapp:") else f"whatsapp:{phone_number}"
        client.messages.create(
            from_=from_whatsapp,
            to=to,
            body=f"Hi {employee_name}, you clocked in at {in_time} today which is after office start time. You are marked LATE today. Please try to reach on time."
        )
        return True
    except Exception as e:
        logging.error(f"failed to send whatsapp reminder to {phone_number}: {e}")
        return False


@app.get("/attendance/late_threshold")
def get_late_threshold_endpoint(user: dict = Depends(require_role("admin"))):
    return {"late_time": get_late_threshold()}


@app.post("/attendance/late_threshold")
def set_late_threshold_endpoint(request: LateThresholdRequest, user: dict = Depends(require_role("admin"))):
    try:
        db = mongodbclient()
        existing = db.get_data(collection_name=ATTENDANCE_SETTINGS_COLLECTION, query={"key": "late_threshold"})
        if existing:
            db.update_data(collection_name=ATTENDANCE_SETTINGS_COLLECTION, query={"key": "late_threshold"},
                            update_values={"value": request.late_time})
        else:
            db.add(collection_name=ATTENDANCE_SETTINGS_COLLECTION, dictionary={"key": "late_threshold", "value": request.late_time})
        return {"message": "late threshold updated", "late_time": request.late_time}
    except Exception as e:
        logging.error("late threshold could not be updated")
        raise HTTPException(status_code=500, detail="late threshold could not be updated")


@app.get("/attendance/")
def get_attendance(date: str = Query(None), month: str = Query(None), user: dict = Depends(require_role("admin"))):
    """date="YYYY-MM-DD" for one day's list, or month="YYYY-MM" for that month's records (monthly report)."""
    try:
        db = mongodbclient()
        query = {}
        if date:
            query["date"] = date
        elif month:
            query["date"] = {"$regex": f"^{re.escape(month)}"}
        dataset = db.get_data(collection_name=ATTENDANCE_COLLECTION, query=query)
        return {"message": "attendance dataset", "dataset": dataset}
    except Exception as e:
        logging.error("attendance dataset could not be fetched")
        raise HTTPException(status_code=500, detail="attendance dataset could not be fetched")


@app.post("/attendance/upload")
async def upload_attendance(file: UploadFile = File(...), user: dict = Depends(require_role("admin"))):
    """
    Takes the daily biometric export as-is (the "DailyPresentList_*.xls" file
    — really an HTML table saved with an .xls extension) and:
      1. reads the date from its "Date : DD-Mon-YYYY" header,
      2. stores one attendance record per employee for that date
         (re-uploading the same day's file updates those records instead of
         duplicating them),
      3. compares each employee's In-Time against the configured late
         threshold and, for anyone late who hasn't already been messaged for
         that date, sends a WhatsApp "you are late today" reminder via
         Twilio (only for employees whose name matches an account in the
         accounts/user collection with a phone number saved — matched
         case-insensitively since device exports and account records don't
         always agree on capitalization).
    """
    try:
        raw_bytes = await file.read()
        raw = raw_bytes.decode("utf-8", errors="ignore")

        date_match = re.search(r"Date\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})", raw)
        if not date_match:
            raise HTTPException(status_code=400, detail="could not find the attendance date (expected a 'Date : DD-Mon-YYYY' header) in this file")
        att_date = datetime.strptime(date_match.group(1), "%d-%b-%Y").strftime("%Y-%m-%d")

        try:
            table_rows = parse_attendance_table(raw)
        except Exception:
            raise HTTPException(status_code=400, detail="could not read an attendance table out of this file")
        if not table_rows or len(table_rows) < 2:
            raise HTTPException(status_code=400, detail="no attendance table found in this file")

        header = [h.strip() for h in table_rows[0]]

        def col_index(name):
            for i, h in enumerate(header):
                if h.strip().lower() == name.lower():
                    return i
            return -1

        idx_emp_code = col_index("Emp Code")
        idx_name = col_index("Employee Name")
        idx_dept = col_index("Department")
        idx_branch = col_index("Branch")
        idx_in = col_index("In-Time")
        idx_out = col_index("Out-Time")
        idx_status = col_index("Status")
        if idx_emp_code == -1 or idx_name == -1:
            raise HTTPException(status_code=400, detail="this file's table doesn't look like the expected attendance format (missing Emp Code / Employee Name columns)")

        def cell(row, idx):
            return row[idx].strip() if idx != -1 and idx < len(row) else ""

        threshold_str = get_late_threshold()
        threshold_time = datetime.strptime(threshold_str, "%H:%M").time()

        db = mongodbclient()
        records_saved = 0
        late_reminders_sent = []
        late_no_contact = []

        for row in table_rows[1:]:
            emp_code = cell(row, idx_emp_code)
            if not emp_code:
                continue
            employee_name = cell(row, idx_name)
            department = cell(row, idx_dept)
            branch = cell(row, idx_branch)
            in_time_str = cell(row, idx_in)
            out_time_str = cell(row, idx_out)
            status = cell(row, idx_status)

            is_late = "LT" in status.upper()
            if in_time_str:
                try:
                    is_late = datetime.strptime(in_time_str, "%H:%M").time() > threshold_time
                except ValueError:
                    pass  # fall back to the device's own P-LT flag above

            existing = db.get_data(collection_name=ATTENDANCE_COLLECTION, query={"date": att_date, "emp_code": emp_code})
            reminder_already_sent = bool(existing[0].get("reminder_sent")) if existing else False

            record = {
                "date": att_date, "emp_code": emp_code, "employee_name": employee_name,
                "department": department, "branch": branch, "in_time": in_time_str,
                "out_time": out_time_str, "status": status, "is_late": is_late,
                "reminder_sent": reminder_already_sent,
            }
            if existing:
                db.update_data(collection_name=ATTENDANCE_COLLECTION, query={"date": att_date, "emp_code": emp_code}, update_values=record)
            else:
                db.add(collection_name=ATTENDANCE_COLLECTION, dictionary=record)
            records_saved += 1

            if is_late and not reminder_already_sent:
                phone = find_employee_phone(db, employee_name)
                if phone:
                    if send_whatsapp_late_reminder(phone, employee_name, in_time_str):
                        db.update_data(collection_name=ATTENDANCE_COLLECTION, query={"date": att_date, "emp_code": emp_code},
                                        update_values={"reminder_sent": True})
                        late_reminders_sent.append(employee_name)
                else:
                    late_no_contact.append(employee_name)

        logging.info(f"attendance uploaded for {att_date}: {records_saved} record(s), {len(late_reminders_sent)} reminder(s) sent")
        return {
            "message": "attendance uploaded",
            "date": att_date,
            "records_saved": records_saved,
            "late_reminders_sent": late_reminders_sent,
            "late_without_contact": late_no_contact,  # late today but no WhatsApp number saved yet
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error("attendance upload failed")
        raise HTTPException(status_code=500, detail="attendance file could not be processed")


@app.post("/dispatch/confirm/order/{order_id}")
def confirm_order_dispatch(order_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = order_manager()
        matches = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        if not matches:
            raise HTTPException(status_code=404, detail="order not found")
        order = matches[0]
        customer = order.get("customer", {})
        dispatch_info = {
            "docket_no": request.docket_no,
            "invoice_no": request.invoice_no,
            "invoice_date": request.invoice_date,
            "mode_of_delivery": request.mode_of_delivery,
            "bill_to_address": {"company_name": customer.get("company_name", ""), "address": customer.get("company_address", "")},
            "ship_to_different": request.ship_to_different,
            "ship_to_address": request.ship_to_address if request.ship_to_different else None,
            "image": request.image,
            "media_updated_at": datetime.now(timezone.utc).isoformat() if request.image else None,
            "dispatched_by": user["username"],
            "dispatched_at": datetime.now(timezone.utc).isoformat()
        }
        update_values = {"dispatch": dispatch_info}
        # Once a docket number exists the order has physically left, so reflect
        # that on the Orders page. Only move it forward from "processing" - never
        # overwrite delivered / cancelled / returned.
        if request.docket_no and order.get("status") == "processing":
            update_values["status"] = "dispatched"
        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id}, update_values=update_values)
        logging.info(f"order {order_id} dispatch confirmed")
        return {"message": "dispatch confirmed", "order_id": order_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order dispatch confirmation failed")
        raise HTTPException(status_code=500, detail="dispatch could not be confirmed")


@app.post("/dispatch/confirm/service/{service_id}")
def confirm_service_dispatch(service_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        matches = db.get_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, projection={"image": 0, "video": 0})
        if not matches:
            raise HTTPException(status_code=404, detail="service not found")
        if matches[0].get("status") != "completed":
            raise HTTPException(status_code=400, detail="only a completed service can be dispatched")
        dispatch_info = {
            "docket_no": request.docket_no,
            "invoice_no": request.invoice_no,
            "invoice_date": request.invoice_date,
            "mode_of_delivery": request.mode_of_delivery,
            "dispatched_through": request.dispatched_through,
            "ship_to_different": request.ship_to_different,
            "ship_to_address": request.ship_to_address if request.ship_to_different else None,
            "image": request.image,
            "media_updated_at": datetime.now(timezone.utc).isoformat() if request.image else None,
            "dispatched_by": user["username"],
            "dispatched_at": datetime.now(timezone.utc).isoformat()
        }
        db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, update_values={"dispatch": dispatch_info})
        logging.info(f"service {service_id} dispatch confirmed")
        return {"message": "dispatch confirmed", "service_id": service_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("service dispatch confirmation failed")
        raise HTTPException(status_code=500, detail="dispatch could not be confirmed")


@app.post("/dispatch/confirm/spare_part/{allocation_id}")
def confirm_spare_part_dispatch(allocation_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        dispatch_info = {
            "docket_no": request.docket_no,
            "invoice_no": request.invoice_no,
            "invoice_date": request.invoice_date,
            "mode_of_delivery": request.mode_of_delivery,
            "ship_to_different": request.ship_to_different,
            "ship_to_address": request.ship_to_address if request.ship_to_different else None,
            "image": request.image,
            "media_updated_at": datetime.now(timezone.utc).isoformat() if request.image else None,
            "dispatched_by": user["username"]
        }
        db.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id}, update_values={"dispatch": dispatch_info})
        logging.info(f"spare part allocation {allocation_id} dispatch confirmed")
        return {"message": "dispatch confirmed", "allocation_id": allocation_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("spare part dispatch confirmation failed")
        raise HTTPException(status_code=500, detail="dispatch could not be confirmed")


@app.get("/service/")
def services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={}, projection=SERVICE_LIST_PROJECTION)
        logging.info("service dataset was fetched successfully")
        return {"message": "service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


def _check_field_address(location: str, address: str) -> str:
    address = (address or "").strip()
    if location == "outdoor" and not address:
        raise HTTPException(status_code=400, detail="enter the address for a field service")
    return address if location == "outdoor" else ""


def _save_service_address(service_id: str, address: str):
    if address:
        service_detail().update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id},
                                     update_values={"address": address})


@app.post("/services/create")
def create_service(request: ServiceRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        address = _check_field_address(request.location, request.address)
        service = service_detail(product_id=request.product_id, serial_no=request.serial_no)
        service.add_service(
            collection_name=SERVICE_COLLECTION,
            purchase_date=request.purchase_date,
            issue=request.issue,
            image=request.image,
            video=request.video,
            technician_id=request.technician_id,
            location=request.location,
            spare_parts=request.spare_parts,
            created_by=user["username"],
            product_name=request.product_name,
            model_no=request.model_no,
            company_name=request.company_name
        )
        _save_service_address(service.service_id, address)
        logging.info(f"service creation was successful with service_id {service.service_id}!")

        _notify([request.technician_id], kind="service_assigned", title="New service assigned to you",
                body=f"{request.product_name or request.product_id} (serial {request.serial_no}) - {request.issue}",
                service_id=service.service_id, link=f"/pages/technician.html?service={service.service_id}")

        if request.video:
            _raise_media_review_request(service.service_id, user["username"])

        return {"message": "service creation was successful!", "service_id": service.service_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("service creation failed!")
        raise HTTPException(status_code=500, detail="service cannot be created!")


@app.post("/service/delete/{service_id}")
def delete_service(service_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.delete_service(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        logging.info(f"service was deleted successfully service id {service_id}")
        return {"message": "service deletion was successful", "service_id": service_id}
    except Exception as e:
        logging.error("service deletion was failed!")
        raise HTTPException(status_code=500, detail="service cannot be deleted")


@app.post("/service/update/{service_id}")
def update_service(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.update_service_status(
            service_status=request.service_status,
            reason=request.reason,
            collection_name=SERVICE_COLLECTION,
            query={"service_id": service_id},
            image=request.image,
            video=request.video,
            spare_parts_used=request.spare_parts_used,
            spare_parts=request.spare_parts,
            service_charges=request.service_charges,
            parts_used=[p.dict() for p in request.parts_used]
        )

        hologram_mismatch = False
        if request.service_status == "completed" and request.spare_parts_used:
            try:
                hologram_mismatch = _swap_faulty_part(service_id, [p.dict() for p in request.parts_used])
            except Exception as swap_err:
                logging.error(f"service {service_id} completed but faulty-part swap failed: {swap_err}")

        # auto-resolve any pending status_update requests raised for this service,
        # since admin/accounts just applied the change directly from the Service page
        req_db = request_manager()
        pending = req_db.get_data(collection_name=REQUESTS_COLLECTION,
                                   query={"request_type": "status_update", "status": "pending",
                                          "details.service_id": service_id})
        for req in pending:
            req_db.set_status(collection_name=REQUESTS_COLLECTION, request_id=req["request_id"],
                               status="approved", resolved_by=user["username"])

        logging.info("service was updated")
        return {"message": "service was updated successfully", "service_id": service_id, "hologram_mismatch": hologram_mismatch}
    except Exception as e:
        logging.error("service updation was unsuccessful!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/service/edit/{service_id}")
def edit_service(service_id: str, request: ServiceEditRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    """Edit the details of a service and/or reassign it to another technician."""
    try:
        db = service_detail(product_id="", serial_no="")
        existing = db.get_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        if not existing:
            raise HTTPException(status_code=404, detail="service not found")
        svc = existing[0]
        changes = request.dict(exclude_unset=True)
        if not changes:
            raise HTTPException(status_code=400, detail="nothing to update")

        update = {}
        for key in ("company_name", "product_name", "model_no", "purchase_date", "spare_parts"):
            if key in changes:
                update[key] = (changes[key] or "").strip()
        if "serial_no" in changes:
            serial = (changes["serial_no"] or "").strip().lower()
            if not serial:
                raise HTTPException(status_code=400, detail="serial number cannot be empty")
            update["serial_no"] = serial
        if "issue" in changes:
            issue = (changes["issue"] or "").strip()
            if not issue:
                raise HTTPException(status_code=400, detail="the issue cannot be empty")
            update["issue"] = issue
        if "service_charges" in changes:
            charges = changes["service_charges"]
            if charges is not None and charges < 0:
                raise HTTPException(status_code=400, detail="service charges cannot be negative")
            update["service_charges"] = charges

        # location + address are validated together (a field service needs an address)
        if "location" in changes or "address" in changes:
            location = changes.get("location") or svc.get("location") or "indoor"
            if location not in ("indoor", "outdoor"):
                raise HTTPException(status_code=400, detail="location must be indoor or outdoor")
            address = _check_field_address(location, changes.get("address", svc.get("address")))
            update["location"] = location
            update["address"] = address

        # reassigning the technician
        old_tech = svc.get("technician_alloted")
        new_tech = None
        if "technician_alloted" in changes:
            new_tech = (changes["technician_alloted"] or "").strip()
            if not new_tech:
                raise HTTPException(status_code=400, detail="select a technician")
            if new_tech != old_tech:
                if svc.get("status") in ("completed", "rejected"):
                    raise HTTPException(status_code=409, detail="a completed or rejected service cannot be reassigned")
                person = mongodbclient().get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": new_tech})
                if not person:
                    raise HTTPException(status_code=404, detail="that technician does not exist")
                if person[0].get("role") == "admin":
                    raise HTTPException(status_code=400, detail="a service cannot be assigned to an admin")
                update["technician_alloted"] = new_tech
            else:
                new_tech = None

        if not update:
            raise HTTPException(status_code=400, detail="nothing to update")
        db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, update_values=update)

        if new_tech:
            label = f"{update.get('product_name') or svc.get('product_name') or svc.get('product_id') or 'Service'} (serial {update.get('serial_no') or svc.get('serial_no') or '-'})"
            _notify([new_tech], kind="service_assigned", title="Service assigned to you",
                    body=f"{label} - {update.get('issue') or svc.get('issue') or ''}",
                    service_id=service_id, link=f"/pages/technician.html?service={service_id}")
            _notify([old_tech], kind="service_reassigned", title="Service reassigned",
                    body=f"{label} was reassigned to {new_tech} by {user['username']}", service_id=service_id)
        logging.info(f"service {service_id} edited by {user['username']}: {sorted(update)}")
        return {"message": "service was updated successfully", "service_id": service_id, "updated": sorted(update)}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("service edit failed!")
        raise HTTPException(status_code=500, detail="service could not be edited")


@app.post("/service/request_status_update/{service_id}")
def request_status_update(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        req = request_manager(
            request_type="status_update",
            raised_by=user["username"],
            details={
                "service_id": service_id,
                "service_status": request.service_status,
                "reason": request.reason,
                "spare_parts": request.spare_parts,
                "spare_parts_used": request.spare_parts_used,
                "service_charges": request.service_charges
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        logging.info(f"status update request raised for service {service_id}")
        return {"message": "status update request sent for approval", "service_id": service_id}
    except Exception as e:
        logging.error("status update request failed!")
        raise HTTPException(status_code=500, detail="status update request could not be sent")


@app.get("/service/my")
def my_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={"technician_alloted": user["username"]}, projection=SERVICE_LIST_PROJECTION)
        logging.info(f"service dataset fetched for technician {user['username']}")
        return {"message": "my service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("technician service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/service/update_charges/{service_id}")
def update_service_charges(service_id: str, request: ServiceChargeRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail()
        db.set_service_charges(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, service_charges=request.service_charges)
        return {"message": "service charges updated", "service_id": service_id, "service_charges": request.service_charges}
    except Exception as e:
        logging.error("service charges update failed!")
        raise HTTPException(status_code=500, detail="service charges cannot be updated")


@app.post("/service/upload_media/{service_id}")
def upload_service_media(service_id: str, request: ServiceMediaRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        db = service_detail()
        db.attach_media(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, image=request.image, video=request.video)

        if request.video:
            _raise_media_review_request(service_id, user["username"])

        return {"message": "media uploaded successfully", "service_id": service_id}
    except Exception as e:
        logging.error("service media upload failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/service/request_spare_part/{service_id}")
def request_spare_part(service_id: str, request: SparePartRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        db = service_detail()
        db.request_spare_part(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, note=request.note)

        req = request_manager(
            request_type="spare_part",
            raised_by=user["username"],
            details={"service_id": service_id, "note": request.note}
        )
        req.add(collection_name=REQUESTS_COLLECTION)

        return {"message": "spare part requested successfully", "service_id": service_id}
    except Exception as e:
        logging.error("spare part request failed!")
        raise HTTPException(status_code=500, detail="spare part request failed")


@app.post("/service/manager_confirm/{service_id}")
def manager_confirm(service_id: str, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.manager_confirm_return(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        return {"message": "manager confirmed part return", "service_id": service_id}
    except Exception as e:
        logging.error("manager confirmation failed!")
        raise HTTPException(status_code=500, detail="manager confirmation failed")


class AddFaultyPartsRequest(BaseModel):
    parts: list[dict] = []   # [{part_name, old_hologram_number}] - must be parts the technician reported on this service


@app.post("/service/add_faulty/{service_id}")
def add_faulty_parts(service_id: str, request: AddFaultyPartsRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    """Files the faulty (removed) part(s) of a service into the Damaged inventory right away: same name as the
    part, the old hologram number as its id. The warranty of the lot it came from is carried over, exactly like
    the automatic filing on completion (which skips anything already filed here)."""
    try:
        svc = service_detail()._get_one(SERVICE_COLLECTION, service_id)
        reported = {(str(p.get("part_name") or "").strip().lower(), str(p.get("old_hologram_number") or "").strip()): p
                    for p in (svc.get("faulty_parts") or [])}
        if not request.parts:
            raise HTTPException(status_code=400, detail="no faulty part selected")
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        added, skipped = [], []
        for item in request.parts:
            name = str(item.get("part_name") or "").strip()
            old = str(item.get("old_hologram_number") or "").strip()
            if not old or (name.lower(), old) not in reported:
                raise HTTPException(status_code=400, detail=f"{name or 'part'} / hologram {old or '-'} was not reported faulty on this service")
            if _faulty_already_filed(name, old):
                skipped.append(old)
                continue
            warranty_until = _damaged_part_warranty(old)
            under_warranty = bool(warranty_until) and warranty_until >= today
            reason = "" if under_warranty else f"damaged part removed during service {service_id}"
            inventory_manager(product_name=name, product_id=old, quantity=1, product_type="damaged",
                              warranty_until=warranty_until, reason=reason).add(collection_name=INVENTORY_COLLECTION)
            added.append(old)
        _record_faulty_filed(service_id, added + skipped)
        return {"message": "faulty part(s) added to inventory" if added else "already in faulty inventory",
                "added": added, "already_filed": skipped, "service_id": service_id}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "faulty part could not be added to inventory")


@app.post("/service/extend_warranty/{service_id}")
def extend_warranty(service_id: str, request: ExtendWarrantyRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.extend_warranty(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, warranty_until=request.warranty_until)
        return {"message": "warranty extended", "service_id": service_id, "warranty_until": request.warranty_until}
    except Exception as e:
        logging.error("warranty extension failed!")
        raise HTTPException(status_code=500, detail="warranty extension failed")


# ---------------------------------------------------------------------------
# In-app notifications (bell icon) - e.g. "New service assigned to you"
# ---------------------------------------------------------------------------
def _notify(usernames, kind: str, title: str, body: str = "", link: str = "", service_id: str = ""):
    """Never raises: a notification problem must not break the action that caused it."""
    try:
        db = mongodbclient()
        now = datetime.now(timezone.utc).isoformat()
        for name in {u for u in usernames if u}:
            db.add(collection_name=NOTIFICATIONS_COLLECTION, dictionary={
                "notification_id": str(uuid.uuid4()), "username": name, "kind": kind,
                "title": title, "body": body, "link": link, "service_id": service_id,
                "read": False, "created_at": now})
    except Exception:
        logging.error("notification could not be saved")


def _service_reviewers(created_by: str = None) -> list:
    names = set()
    try:
        for row in mongodbclient().get_data(collection_name=ACCOUNTS_COLLECTION, query={"role": "service_manager"}):
            names.add(row.get("username"))
    except Exception:
        logging.error("service managers could not be listed for notification")
    if created_by:
        names.add(created_by)
    return [n for n in names if n]


@app.get("/notification/mine")
def my_notifications(user: dict = Depends(get_current_user)):
    try:
        run_in_background("service_reminders", send_service_reminders, 1800)
        rows = mongodbclient().get_data(collection_name=NOTIFICATIONS_COLLECTION, query={"username": user["username"]})
        rows = sorted(rows, key=lambda r: r.get("created_at") or "", reverse=True)[:30]
        return {"message": "my notifications", "dataset": rows}
    except Exception:
        logging.error("notifications cannot be fetched")
        raise HTTPException(status_code=500, detail="notifications cannot be fetched")


@app.post("/notification/read/{notification_id}")
def read_notification(notification_id: str, user: dict = Depends(get_current_user)):
    try:
        mongodbclient().update_data(collection_name=NOTIFICATIONS_COLLECTION,
                                    query={"notification_id": notification_id, "username": user["username"]},
                                    update_values={"read": True})
        return {"message": "marked as read"}
    except Exception:
        logging.error("notification could not be marked read")
        raise HTTPException(status_code=500, detail="notification cannot be updated")


@app.post("/notification/read_all")
def read_all_notifications(user: dict = Depends(get_current_user)):
    try:
        mongodbclient().update_data(collection_name=NOTIFICATIONS_COLLECTION,
                                    query={"username": user["username"], "read": False},
                                    update_values={"read": True}, many=True)
        return {"message": "all marked as read"}
    except Exception:
        logging.error("notifications could not be marked read")
        raise HTTPException(status_code=500, detail="notifications cannot be updated")


# ---------------------------------------------------------------------------
# Technician service workflow
#   start (damaged product image + serial) -> spare part decision -> service report
#   -> pending_approval -> service manager approves the faulty part return -> completed
# ---------------------------------------------------------------------------
def _flow_http_error(e: Exception, fallback: str):
    if isinstance(e, ServiceFlowError):
        return HTTPException(status_code=e.status_code, detail=str(e))
    logging.error(fallback)
    return HTTPException(status_code=500, detail=fallback)


@app.post("/service/start/{service_id}")
def flow_start(service_id: str, request: ServiceStartRequest, user: dict = Depends(require_role("technician", "distributor"))):
    try:
        mismatch = service_detail().start_service(SERVICE_COLLECTION, service_id, user["username"],
                                                  request.damage_image, request.serial_no)
        return {"message": "service started", "service_id": service_id, "serial_mismatch": mismatch}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "service could not be started")


@app.post("/service/spare_decision/{service_id}")
def flow_spare_decision(service_id: str, request: SpareDecisionRequest, user: dict = Depends(require_role("technician", "distributor"))):
    try:
        db = service_detail()
        before = db._get_one(SERVICE_COLLECTION, service_id)
        parts = db.save_spare_decision(SERVICE_COLLECTION, service_id, user["username"], request.spare_needed,
                                       [p.dict() for p in request.parts])
        if request.spare_needed:
            note = "; ".join(f"{p['part_name']} (old hologram {p['old_hologram_number']})" for p in parts)
            if note != (before.get("spare_parts_requested") or ""):
                # same request the old "Request Spare Part" button raised, so the service manager can allocate the part
                db.request_spare_part(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, note=note)
                req = request_manager(request_type="spare_part", raised_by=user["username"],
                                      details={"service_id": service_id, "note": note,
                                               "parts": [{"part_name": p["part_name"],
                                                          "old_hologram_number": p.get("old_hologram_number", "")} for p in parts]})
                req.add(collection_name=REQUESTS_COLLECTION)
                _notify(_service_reviewers(), kind="spare_part_request", title="Spare part request",
                        body=f"{user['username']} needs: {note}", service_id=service_id,
                        link="/pages/service.html?tab=requests")
        return {"message": "spare part decision saved", "service_id": service_id}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "spare part decision could not be saved")


@app.post("/service/submit_report/{service_id}")
def flow_submit_report(service_id: str, request: ServiceReportRequest, user: dict = Depends(require_role("technician", "distributor"))):
    try:
        db = service_detail()
        svc = db.submit_report(SERVICE_COLLECTION, service_id, user["username"], request.work_done,
                               {p.old_hologram_number: p.new_hologram_number for p in request.parts}, request.final_image)
        _notify(_service_reviewers(svc.get("created_by")), kind="service_report", title="Service report waiting for approval",
                body=f"{user['username']} submitted the report for {svc.get('product_name') or svc.get('product_id')} "
                     f"(serial {svc.get('serial_no')}). Approve once the faulty part is returned.",
                service_id=service_id, link=f"/pages/service.html?review={service_id}")
        return {"message": "report sent for approval", "service_id": service_id}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "service report could not be submitted")


@app.post("/service/approve_completion/{service_id}")
def flow_approve(service_id: str, request: ServiceApproveRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail()
        svc = db._get_one(SERVICE_COLLECTION, service_id)
        if svc.get("status") != "pending_approval":
            raise ServiceFlowError("only a service whose report is waiting for approval can be approved", 409)
        charges = request.service_charges if request.service_charges is not None else svc.get("service_charges")
        if charges is None or float(charges) < 0:
            raise ServiceFlowError("enter the service charges before approving")

        # faulty part(s) go into the Damaged inventory and the assembly hologram rolls forward
        hologram_mismatch = False
        parts = db.pending_parts_for_swap(svc)
        if parts:
            hologram_mismatch = _swap_faulty_part(service_id, parts)
        db.approve_completion(SERVICE_COLLECTION, service_id, user["username"], request.service_charges)

        _notify([svc.get("technician_alloted")], kind="service_completed", title="Service completed",
                body=f"{svc.get('product_name') or svc.get('product_id')} (serial {svc.get('serial_no')}) was approved by {user['username']}.",
                service_id=service_id, link=f"/pages/technician.html?service={service_id}")
        return {"message": "service approved and completed", "service_id": service_id, "hologram_mismatch": hologram_mismatch}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "service could not be approved")


@app.post("/service/send_back/{service_id}")
def flow_send_back(service_id: str, request: ServiceSendBackRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        db = service_detail()
        svc = db.reject_report(SERVICE_COLLECTION, service_id, request.reason)
        _notify([svc.get("technician_alloted")], kind="service_sent_back", title="Service report sent back",
                body=f"{user['username']}: {request.reason.strip()}",
                service_id=service_id, link=f"/pages/technician.html?service={service_id}")
        return {"message": "report sent back to the technician", "service_id": service_id}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "report could not be sent back")


def _file_reschedule_request(kind: str, target_id: str, label: str, when: str, note: str, current, user: dict) -> str:
    db = request_manager()
    pending = db.get_data(collection_name=REQUESTS_COLLECTION,
                          query={"request_type": "reschedule", "status": "pending", "details.target_id": target_id})
    if pending:
        raise HTTPException(status_code=409, detail="a reschedule request for this is already waiting for approval")
    req = request_manager(request_type="reschedule", raised_by=user["username"], details={
        "kind": kind, "target_id": target_id, "label": label, "requested_date": when,
        "current_date": current, "reason": (note or "").strip()})
    req.add(collection_name=REQUESTS_COLLECTION)
    _notify(_service_reviewers(), kind="reschedule_request", title="Reschedule request",
            body=f"{user['username']}: {label} -> {when}" + (f" - {note.strip()}" if note and note.strip() else ""),
            service_id=target_id, link="/pages/service.html?tab=requests")
    return req.request_id


def _apply_installation_schedule(inst: dict, when: str, note: str, by: str):
    now = datetime.now(timezone.utc).isoformat()
    history = list(inst.get("schedule_history") or []) + [
        {"from": inst.get("scheduled_date"), "to": when, "note": (note or "").strip(), "by": by, "at": now}]
    mongodbclient().update_data(collection_name=INSTALLATION_COLLECTION, query={"installation_id": inst["installation_id"]},
                                update_values={"technician_id": inst.get("technician_id"), "scheduled_date": when,
                                               "schedule_history": history, "last_reminder_at": now,
                                               "status": "scheduled" if inst.get("status") == "requested" else inst.get("status")})


def _apply_reschedule_request(details: dict, raised_by: str):
    kind, target, when, reason = details.get("kind"), details.get("target_id"), details.get("requested_date"), details.get("reason", "")
    if kind == "service":
        service_detail().reschedule_service(SERVICE_COLLECTION, target, when, reason, raised_by)
    elif kind == "installation":
        inst = _get_installation(target)
        if inst.get("status") == "completed":
            raise HTTPException(status_code=409, detail="a completed installation cannot be rescheduled")
        _apply_installation_schedule(inst, _valid_schedule(when), reason, raised_by)
    else:
        raise HTTPException(status_code=400, detail="unknown reschedule request")


@app.post("/service/reschedule/{service_id}")
def flow_reschedule(service_id: str, request: ServiceRescheduleRequest,
                    user: dict = Depends(require_role("technician", "distributor", "service_manager", "admin", "accounts"))):
    try:
        db = service_detail()
        existing = db.get_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        if not existing:
            raise HTTPException(status_code=404, detail="service not found")
        svc = existing[0]
        tech = svc.get("technician_alloted")
        if user["role"] in ("technician", "distributor") and tech != user["username"]:
            raise HTTPException(status_code=403, detail="this service is not assigned to you")
        when = _valid_schedule(request.scheduled_date)
        if user["role"] in ("technician", "distributor"):
            if svc.get("status") in ("completed", "rejected"):
                raise HTTPException(status_code=409, detail="this service can no longer be rescheduled")
            label = f"{svc.get('product_name') or svc.get('product_id') or 'Service'} (serial {svc.get('serial_no') or '-'})"
            request_id = _file_reschedule_request("service", service_id, label, when, request.reason, svc.get("scheduled_date"), user)
            return {"message": "reschedule request sent for approval", "pending_approval": True, "request_id": request_id}
        db.reschedule_service(SERVICE_COLLECTION, service_id, when, request.reason, user["username"])
        body = f"{when}" + (f" - {request.reason.strip()}" if request.reason.strip() else "")
        _notify([tech], kind="service_rescheduled", title="Service rescheduled",
                body=f"{user['username']}: {body}", service_id=service_id, link=f"/pages/technician.html?service={service_id}")
        return {"message": "service rescheduled", "service_id": service_id, "scheduled_date": when}
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "service could not be rescheduled")


@app.get("/allocation/technician")
def technician_allocations(user: dict = Depends(get_current_user)):
    """Demo units held by this technician + spare parts allocated against their services."""
    try:
        db = mongodbclient()
        demo = db.get_data(collection_name=ALLOCATION_COLLECTION,
                           query={"allocation_type": {"$in": ["demo_unit", "product"]}, "allocated_by": user["username"]},
                           projection={"damage_report.image": 0, "dispatch.image": 0})
        my_ids = [s.get("service_id") for s in db.get_data(
            collection_name=SERVICE_COLLECTION, query={"technician_alloted": user["username"]},
            projection={"service_id": 1}) if s.get("service_id")]
        parts = []
        if my_ids:
            parts = db.get_data(collection_name=ALLOCATION_COLLECTION,
                                query={"allocation_type": "spare_part", "spare_part.service_id": {"$in": my_ids}},
                                projection={"damage_report.image": 0, "dispatch.image": 0})
        for rows in (demo, parts):
            for r in rows:
                r.pop("_id", None)
        return {"message": "technician allocations", "demo_units": demo, "spare_parts": parts}
    except Exception:
        logging.error("technician allocations cannot be fetched")
        raise HTTPException(status_code=500, detail="technician allocations cannot be fetched")


# ---------------------------------------------------------------------------
# Installations: product installation requests that a technician can schedule
# ---------------------------------------------------------------------------
INSTALLATION_STATUSES = ("requested", "scheduled", "in_progress", "pending_approval", "completed")
INSTALLATION_MANAGERS = ("service_manager", "admin", "accounts")


def _clean(row: dict) -> dict:
    row.pop("_id", None)
    return row


def _clean_list(row: dict) -> dict:
    """List responses never carry the heavy base64 photo; fetch it via /installation/media/{id}."""
    row = _clean(row)
    row["has_completion_image"] = bool(row.pop("completion_image", None))
    return row


def _get_installation(installation_id: str) -> dict:
    rows = mongodbclient().get_data(collection_name=INSTALLATION_COLLECTION, query={"installation_id": installation_id})
    if not rows:
        raise HTTPException(status_code=404, detail="installation not found")
    return rows[0]


def _check_install_access(inst: dict, user: dict):
    if user["role"] in INSTALLATION_MANAGERS:
        return
    if inst.get("technician_id") != user["username"]:
        raise HTTPException(status_code=403, detail="this installation is not assigned to you")


def _valid_schedule(value: str) -> str:
    try:
        datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        raise HTTPException(status_code=400, detail="enter a valid date and time")
    return str(value)


@app.post("/installation/create")
def create_installation(request: InstallationCreateRequest,
                        user: dict = Depends(require_role("technician", "distributor", "service_manager", "admin", "accounts", "sales"))):
    try:
        if not request.product_name.strip() or not request.company_name.strip():
            raise HTTPException(status_code=400, detail="product name and customer are required")
        now = datetime.now(timezone.utc).isoformat()
        tech = request.technician_id.strip()
        if user["role"] in ("technician", "distributor") and not tech:
            tech = user["username"]
        installation_id = str(uuid.uuid4())
        doc = {
            "installation_id": installation_id, "product_name": request.product_name.strip(),
            "model_no": request.model_no.strip(), "serial_no": request.serial_no.strip(),
            "company_name": request.company_name.strip(), "address": request.address.strip(),
            "contact_person": request.contact_person.strip(), "contact_number": request.contact_number.strip(),
            "technician_id": tech or None, "preferred_date": request.preferred_date, "notes": request.notes.strip(),
            "status": "requested", "scheduled_date": None, "schedule_history": [], "history": [],
            "requested_by": user["username"], "created_at": now, "last_reminder_at": None,
        }
        mongodbclient().add(collection_name=INSTALLATION_COLLECTION, dictionary=doc)
        _notify([tech] if tech else _service_reviewers(), kind="installation_requested", title="New installation request",
                body=f"{doc['product_name']} - {doc['company_name']}", service_id=installation_id,
                link=f"/pages/technician.html?installation={installation_id}")
        return {"message": "installation requested", "installation_id": installation_id}
    except HTTPException:
        raise
    except Exception:
        logging.error("installation could not be created")
        raise HTTPException(status_code=500, detail="installation could not be created")


@app.get("/installation/")
def list_installations(user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        rows = mongodbclient().get_data(collection_name=INSTALLATION_COLLECTION, query={})
        rows = sorted((_clean_list(r) for r in rows), key=lambda r: r.get("created_at") or "", reverse=True)
        return {"message": "installations", "dataset": rows}
    except Exception:
        logging.error("installations cannot be fetched")
        raise HTTPException(status_code=500, detail="installations cannot be fetched")


@app.get("/installation/mine")
def my_installations(user: dict = Depends(get_current_user)):
    """Installations assigned to me, plus unassigned requests (so any technician can pick them up)."""
    try:
        rows = mongodbclient().get_data(collection_name=INSTALLATION_COLLECTION, query={
            "$or": [{"technician_id": user["username"]}, {"technician_id": None}, {"technician_id": ""}]})
        rows = sorted((_clean_list(r) for r in rows), key=lambda r: r.get("created_at") or "", reverse=True)
        return {"message": "my installations", "dataset": rows}
    except Exception:
        logging.error("my installations cannot be fetched")
        raise HTTPException(status_code=500, detail="installations cannot be fetched")


@app.get("/installation/media/{installation_id}")
def installation_media(installation_id: str, user: dict = Depends(get_current_user)):
    try:
        inst = _get_installation(installation_id)
        _check_install_access(inst, user)
        return {"installation_id": installation_id, "completion_image": inst.get("completion_image") or "",
                "completion_note": inst.get("completion_note") or ""}
    except HTTPException:
        raise
    except Exception:
        logging.error("installation media cannot be fetched")
        raise HTTPException(status_code=500, detail="installation media cannot be fetched")


@app.post("/installation/assign/{installation_id}")
def assign_installation(installation_id: str, request: InstallationAssignRequest,
                        user: dict = Depends(require_role("technician", "distributor", "service_manager", "admin", "accounts"))):
    try:
        inst = _get_installation(installation_id)
        # a technician may only take an unassigned request (or hand over their own)
        if user["role"] in ("technician", "distributor") and inst.get("technician_id") not in (None, "", user["username"]):
            raise HTTPException(status_code=403, detail="this installation is assigned to someone else")
        tech = request.technician_id.strip()
        if not tech:
            raise HTTPException(status_code=400, detail="select a technician")
        mongodbclient().update_data(collection_name=INSTALLATION_COLLECTION, query={"installation_id": installation_id},
                                    update_values={"technician_id": tech, "last_reminder_at": datetime.now(timezone.utc).isoformat()})
        _notify([tech], kind="installation_assigned", title="Installation assigned to you",
                body=f"{inst.get('product_name')} - {inst.get('company_name')}", service_id=installation_id,
                link=f"/pages/technician.html?installation={installation_id}")
        return {"message": "installation assigned", "installation_id": installation_id}
    except HTTPException:
        raise
    except Exception:
        logging.error("installation could not be assigned")
        raise HTTPException(status_code=500, detail="installation could not be assigned")


@app.post("/installation/schedule/{installation_id}")
def schedule_installation(installation_id: str, request: InstallationScheduleRequest,
                          user: dict = Depends(require_role("technician", "distributor", "service_manager", "admin", "accounts"))):
    try:
        inst = _get_installation(installation_id)
        is_tech = user["role"] in ("technician", "distributor")
        if is_tech and not inst.get("technician_id"):
            inst["technician_id"] = user["username"]
        _check_install_access(inst, user)
        if inst.get("status") == "completed":
            raise HTTPException(status_code=409, detail="a completed installation cannot be rescheduled")
        when = _valid_schedule(request.scheduled_date)
        if is_tech and inst.get("scheduled_date"):
            label = f"Installation: {inst.get('product_name')} - {inst.get('company_name')}"
            request_id = _file_reschedule_request("installation", installation_id, label, when, request.note, inst.get("scheduled_date"), user)
            return {"message": "reschedule request sent for approval", "pending_approval": True, "request_id": request_id}
        _apply_installation_schedule(inst, when, request.note, user["username"])
        notify_to = _service_reviewers() if user["username"] == inst.get("technician_id") else [inst.get("technician_id")]
        _notify(notify_to, kind="installation_scheduled", title="Installation scheduled",
                body=f"{inst.get('product_name')} - {inst.get('company_name')} on {when}", service_id=installation_id,
                link=f"/pages/technician.html?installation={installation_id}")
        return {"message": "installation scheduled", "installation_id": installation_id, "scheduled_date": when}
    except HTTPException:
        raise
    except Exception:
        logging.error("installation could not be scheduled")
        raise HTTPException(status_code=500, detail="installation could not be scheduled")


@app.post("/installation/status/{installation_id}")
def installation_status(installation_id: str, request: InstallationStatusRequest,
                        user: dict = Depends(require_role("technician", "distributor", "service_manager", "admin", "accounts"))):
    try:
        if request.status not in INSTALLATION_STATUSES:
            raise HTTPException(status_code=400, detail="invalid status")
        inst = _get_installation(installation_id)
        _check_install_access(inst, user)
        if request.status in ("in_progress", "pending_approval", "completed") and not inst.get("technician_id"):
            raise HTTPException(status_code=409, detail="assign a technician first")
        now = datetime.now(timezone.utc).isoformat()
        history = list(inst.get("history") or []) + [
            {"status": request.status, "note": request.note.strip(), "by": user["username"], "at": now}]
        update = {"status": request.status, "history": history}
        if request.status == "pending_approval":
            if not request.image or not request.image.startswith("data:image/"):
                raise HTTPException(status_code=400, detail="completion photo is required")
            update["completion_image"] = request.image
            update["completion_note"] = request.note.strip()
        if request.status == "completed":
            update["completed_at"] = now
        mongodbclient().update_data(collection_name=INSTALLATION_COLLECTION, query={"installation_id": installation_id},
                                    update_values=update)
        if user["username"] == inst.get("technician_id"):
            _notify(_service_reviewers(), kind="installation_status", title=f"Installation {request.status.replace('_', ' ')}",
                    body=f"{inst.get('product_name')} - {inst.get('company_name')}", service_id=installation_id,
                    link=f"/pages/service.html?installation={installation_id}")
        return {"message": "installation updated", "installation_id": installation_id, "status": request.status}
    except HTTPException:
        raise
    except Exception:
        logging.error("installation status could not be updated")
        raise HTTPException(status_code=500, detail="installation status could not be updated")


# ---------------------------------------------------------------------------
# 24h reminders for every service / installation that is not completed
# ---------------------------------------------------------------------------
REMINDER_HOURS = 24


def send_service_reminders():
    """Never raises. Each pending item notifies its owner once per REMINDER_HOURS until completed."""
    try:
        db = service_detail(product_id="", serial_no="")
        for svc in db.services_due_for_reminder(SERVICE_COLLECTION, REMINDER_HOURS):
            sid = svc.get("service_id")
            tech = svc.get("technician_alloted")
            label = f"{svc.get('product_name') or svc.get('product_id') or 'Service'} ({svc.get('company_name') or sid})"
            if svc.get("status") == "pending_approval" or not tech:
                who, link = _service_reviewers(), f"/pages/service.html?service={sid}"
                title = "Service waiting for your review" if tech else "Service not assigned yet"
            else:
                who, link = [tech], f"/pages/technician.html?service={sid}"
                title = "Reminder: service not completed"
            _notify(who, kind="service_reminder", title=title, body=f"{label} is still {svc.get('status')}",
                    service_id=sid, link=link)
            db.mark_reminded(SERVICE_COLLECTION, sid)
    except Exception as e:
        logging.error(f"service reminders failed: {e}")
    try:
        mdb = mongodbclient()
        limit = datetime.now(timezone.utc) - timedelta(hours=REMINDER_HOURS)
        for inst in mdb.get_data(collection_name=INSTALLATION_COLLECTION, query={"status": {"$ne": "completed"}}):
            raw = inst.get("last_reminder_at") or inst.get("created_at")
            try:
                last = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                if last.tzinfo is None:
                    last = last.replace(tzinfo=timezone.utc)
            except Exception:
                last = None
            if last is not None and last > limit:
                continue
            iid, tech = inst.get("installation_id"), inst.get("technician_id")
            _notify([tech] if tech else _service_reviewers(), kind="installation_reminder",
                    title="Reminder: installation not completed",
                    body=f"{inst.get('product_name')} - {inst.get('company_name')} is still {inst.get('status')}",
                    service_id=iid, link=f"/pages/technician.html?installation={iid}")
            mdb.update_data(collection_name=INSTALLATION_COLLECTION, query={"installation_id": iid},
                            update_values={"last_reminder_at": datetime.now(timezone.utc).isoformat()})
    except Exception as e:
        logging.error(f"installation reminders failed: {e}")


def _reminder_loop():
    while True:
        send_service_reminders()
        time.sleep(1800)


@app.get("/service/media/{service_id}")
def flow_media(service_id: str, user: dict = Depends(require_role("service_manager", "admin", "accounts", "technician", "distributor"))):
    try:
        media = service_detail().get_media(SERVICE_COLLECTION, service_id)
        if user["role"] in ("technician", "distributor") and media["technician_alloted"] != user["username"]:
            raise HTTPException(status_code=403, detail="this service is not assigned to you")
        return media
    except HTTPException:
        raise
    except Exception as e:
        raise _flow_http_error(e, "service images cannot be fetched")


@app.get("/inventory/")
def inventory(user: dict = Depends(get_current_user)):
    try:
        # serial_numbers and hologram_numbers were the bulk of this endpoint's
        # payload (measured: one lot's hologram_numbers alone was 166KB) and
        # the table doesn't render them directly — View/Edit/Repair fetch the
        # full row on demand instead (see /inventory/detail). The one thing
        # the table DOES need from hologram_numbers is its length, for the
        # spare/service parts Status badge — an aggregation $size keeps that
        # without shipping the array itself.
        col = mongodbclient().database[INVENTORY_COLLECTION]
        pipeline = [
            {"$addFields": {"hologram_count": {"$size": {"$ifNull": ["$hologram_numbers", []]}}}},
            {"$project": {"serial_numbers": 0, "hologram_numbers": 0}}
        ]
        dataset = list(col.aggregate(pipeline))
        for item in dataset:
            item["_id"] = str(item["_id"])

        # warranty entries don't flip on their own — work it out fresh on every
        # fetch by comparing today's date to the stored warranty_until.
        # Applies to any item that carries a warranty_until: service_parts
        # with part_category=="warranty", AND spare_parts (covered under the
        # product's own warranty from the shipment).
        today_dt = datetime.now(timezone.utc)
        today = today_dt.strftime("%Y-%m-%d")
        for item in dataset:
            if item.get("warranty_until"):
                item["warranty_status"] = "over warranty" if item["warranty_until"] < today else "under warranty"
                if item["warranty_status"] == "under warranty":
                    try:
                        expiry = datetime.strptime(item["warranty_until"], "%Y-%m-%d")
                        item["warranty_days_left"] = (expiry - today_dt.replace(tzinfo=None)).days
                    except ValueError:
                        item["warranty_days_left"] = None

        logging.info("inventory dataset was fetched successfully")
        return {"message": "inventory dataset", "dataset": dataset}
    except Exception as e:
        logging.error("inventory dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="inventory dataset cannot be fetched")


@app.get("/inventory/detail")
def inventory_detail(product_id: str = "", model_no: str = "", product_type: str = "", lot_id: str = "",
                      user: dict = Depends(get_current_user)):
    """
    Fresh, full copy of one lot — including serial_numbers/hologram_numbers,
    which the main /inventory/ list no longer carries (they were the bulk of
    its payload). Called on demand when View/Edit/Repair is opened on a row,
    instead of relying on the (now-lighter) cached list.
    """
    try:
        # model_no is only added to the query when one was actually passed in.
        # Older lots (created before model_no existed) or model-less product
        # types store it as null/missing, not "" — querying {"model_no": ""}
        # against those wouldn't match, which is what was making this
        # endpoint 404 and silently fall back to the serial-less cached row
        # on the frontend. Matching on product_id (+ product_type) alone when
        # no model_no was given avoids that false negative.
        # exact lot only: empty model_no = the model-less lot (null/""), NOT "any variant";
        # "product" also matches old lots that have no product_type stored.
        query = {"product_id": product_id,
                 "model_no": model_no if model_no else {"$in": [None, ""]}}
        if product_type == "product":
            query["product_type"] = {"$in": ["product", None]}
        elif product_type:
            query["product_type"] = product_type
        # parts (spare/service) have no product_id, so product_id+model_no+type is not unique —
        # when the caller knows the exact lot, fetch that one
        if lot_id:
            try:
                query = {"_id": ObjectId(lot_id)}
            except Exception:
                raise HTTPException(status_code=400, detail="invalid lot id")
        db = inventory_manager()
        docs = db.get_data(collection_name=INVENTORY_COLLECTION, query=query)
        if not docs:
            raise HTTPException(status_code=404, detail="product not found")
        item = docs[0]
        # Mongo's _id is an ObjectId, which FastAPI can't JSON-serialize on
        # its own — this was crashing the response *after* the try/except
        # below with a 500, since the crash happens during serialization,
        # not inside this function. The /inventory/ list endpoint already
        # does this same conversion; this endpoint was missing it.
        if "_id" in item:
            item["_id"] = str(item["_id"])

        today_dt = datetime.now(timezone.utc)
        today = today_dt.strftime("%Y-%m-%d")
        if item.get("warranty_until"):
            item["warranty_status"] = "over warranty" if item["warranty_until"] < today else "under warranty"
            if item["warranty_status"] == "under warranty":
                try:
                    expiry = datetime.strptime(item["warranty_until"], "%Y-%m-%d")
                    item["warranty_days_left"] = (expiry - today_dt.replace(tzinfo=None)).days
                except ValueError:
                    item["warranty_days_left"] = None

        return {"message": "product detail", "product": item}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"inventory detail cannot be fetched: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _record_for_view(doc):
    """JSON-safe copy of a stored record for the Record page's detail view: drops Mongo _id,
    turns ObjectId / datetime etc. into strings and replaces huge strings (e.g. embedded
    images) with a short placeholder so the response stays small."""
    if isinstance(doc, dict):
        return {str(k): _record_for_view(v) for k, v in doc.items() if k != "_id"}
    if isinstance(doc, (list, tuple, set)):
        return [_record_for_view(v) for v in doc]
    if isinstance(doc, str):
        return doc if len(doc) <= 1000 else "[long value omitted]"
    if doc is None or isinstance(doc, (bool, int, float)):
        return doc
    return str(doc)


@app.get("/inventory/serial_history/{serial_number}")
def serial_history(serial_number: str, user: dict = Depends(get_current_user)):
    """
    Full lifetime trail for one serial number, stitched together from every
    collection that could mention it — inventory (current stock), assembly
    (when/how it was built), orders (sold + any return), and allocations
    (demo unit or sales-person allocation + any return/damage), plus every
    service record raised against it. Returned as a single chronologically
    sorted timeline so the "Record" search on the Inventory page can show a
    unit's whole history in one place: how it entered stock, where it went,
    and what happened to it since.
    """
    try:
        # every serial is lowercased when it's first added to inventory (see
        # inventory.js), so the lookup here has to match on the same
        # lowercased value or a serial typed in with different case (as
        # printed on the unit's physical label) would silently find nothing.
        serial_number = serial_number.strip().lower()
        if not serial_number:
            raise HTTPException(status_code=400, detail="serial number is required")

        # Stored serials are not consistently lowercase (assembly serials are
        # upper-case, imported/typed ones vary, some carry stray spaces), so an
        # exact lowercase match missed many of them. Match case-insensitively
        # and ignore surrounding whitespace in every collection, and compare
        # the same way in Python below.
        rx = {"$regex": r"^\s*" + re.escape(serial_number) + r"\s*$", "$options": "i"}

        def _same(v):
            return str(v or "").strip().lower() == serial_number

        def _has(lst):
            return any(_same(x) for x in (lst or []))

        events = []

        # Every event also carries "full" = the whole underlying record (order, allocation, service ...)
        # so the Record page can open it when an event is clicked. Full records hold prices and customer
        # data, so they are only sent to roles that already manage those pages; everyone else keeps
        # getting just the short "details" summary.
        _can_see_full = user.get("role") in ("admin", "accounts", "inventory_manager") or bool(
            _borrowed_roles(user["username"]) & {"accounts", "inventory_manager"})

        def _full(doc):
            return _record_for_view(doc) if _can_see_full else None

        # ---- Currently in inventory (and under which category) ----
        inv_db = inventory_manager()
        inv_entries = inv_db.get_data(collection_name=INVENTORY_COLLECTION, query={"serial_numbers": rx})
        for entry in inv_entries:
            events.append({
                "type": "inventory",
                "label": f"In stock — {productTypeLabelPy(entry.get('product_type'))}",
                "date": entry.get("purchase_date"),
                "details": {
                    "product_name": entry.get("product_name"),
                    "product_id": entry.get("product_id"),
                    "model_no": entry.get("model_no"),
                    "supplier": entry.get("supplier"),
                    "lot_no": entry.get("lot_no"),
                    "product_type": entry.get("product_type"),
                    "reason": entry.get("reason") or None,
                },
                "full": _full(entry),
            })

        # ---- Assembly (when/how this unit was built, if it was assembled in-house) ----
        asm_db = assembly_manager()
        assemblies = asm_db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"serials.serial_number": rx})
        for asm in assemblies:
            serial_entry = next((s for s in asm.get("serials", []) if _same(s.get("serial_number"))), {})
            events.append({
                "type": "assembly",
                "label": "Assembled",
                "date": asm.get("completed_at") or asm.get("assembly_date") or asm.get("created_at"),
                "details": {
                    "assembly_id": asm.get("assembly_id"),
                    "product_name": asm.get("product_name"),
                    "hologram_number": serial_entry.get("hologram_number"),
                    "status": asm.get("status"),
                },
                "full": _full(asm),
            })

        # ---- Orders (sale + any return) ----
        order_db = order_manager()
        orders = order_db.get_data(collection_name=ORDERS_COLLECTION, query={"items.serial_numbers": rx})
        for o in orders:
            item = next((it for it in o.get("items", []) if _has(it.get("serial_numbers"))), {})
            events.append({
                "type": "order",
                "label": "Sold via order",
                "date": o.get("order_date"),
                "details": {
                    "order_id": o.get("order_id"),
                    "product_name": item.get("product_name"),
                    "company_name": (o.get("customer") or {}).get("company_name"),
                    "status": o.get("status"),
                },
                "full": _full(o),
            })
            if o.get("status") == "returned":
                ret_item = next((r for r in (o.get("returned_items") or []) if _has(r.get("serial_numbers"))), None)
                events.append({
                    "type": "order_return",
                    "label": "Returned (order)",
                    "date": o.get("return_date") or o.get("order_date"),
                    "details": {
                        "order_id": o.get("order_id"),
                        "reason": o.get("return_reason"),
                        "condition": ret_item.get("condition") if ret_item else None,
                    },
                    "full": _full(o),
                })

        # ---- Allocations (demo unit or sales-person product allocation + return/damage) ----
        alloc_db = allocation_manager()
        allocations = alloc_db.get_data(collection_name=ALLOCATION_COLLECTION, query={"items.serial_numbers": rx})
        for a in allocations:
            item = next((it for it in a.get("items", []) if _has(it.get("serial_numbers"))), {})
            is_demo = a.get("allocation_type") == "demo_unit"
            events.append({
                "type": "allocation",
                "label": "Allocated to demo/customer" if is_demo else "Allocated to sales person",
                "date": a.get("allotment_date"),
                "details": {
                    "allocation_id": a.get("allocation_id"),
                    "product_name": item.get("product_name"),
                    "to": (a.get("customer") or {}).get("company_name") if is_demo else (a.get("sales_person") or {}).get("name"),
                    "allocated_by": a.get("allocated_by"),
                    "return_status": a.get("return_status"),
                },
                "full": _full(a),
            })
            if a.get("return_status") == "returned":
                damage = a.get("damage_report") or {}
                events.append({
                    "type": "allocation_return",
                    "label": "Returned (allocation)" + (" — faulty" if damage.get("reported") else ""),
                    "date": a.get("return_completed_at") or a.get("returned_on"),
                    "details": {
                        "allocation_id": a.get("allocation_id"),
                        "returned_by": a.get("returned_by"),
                        "faulty": bool(damage.get("reported")),
                        "issue": damage.get("issue"),
                    },
                    "full": _full(a),
                })

        # ---- Service records raised against this serial ----
        svc_db = service_detail(product_id="", serial_no="")
        try:
            services = svc_db.get_service_data(collection_name=SERVICE_COLLECTION, query={"serial_no": rx})
        except Exception:
            services = svc_db.get_service_data(collection_name=SERVICE_COLLECTION, query={"serial_no": serial_number})
        for s in services:
            events.append({
                "type": "service",
                "label": f"Service — {s.get('service_status', 'raised')}",
                "date": s.get("created_at") or s.get("purchase_date"),
                "details": {
                    "service_id": s.get("service_id"),
                    "issue": s.get("issue"),
                    "status": s.get("service_status"),
                    "technician_id": s.get("technician_id"),
                },
                "full": _full(s),
            })

        # dates can come back as plain "YYYY-MM-DD" strings from some
        # collections and as native datetime objects from others — sorting
        # a mix of the two raises a TypeError ("'<' not supported between
        # instances of 'datetime.datetime' and 'str'"), which was another
        # way this endpoint could 500. Stringify every date before sorting.
        events.sort(key=lambda e: str(e.get("date") or ""))
        for e in events:
            if e.get("date") is not None and not isinstance(e["date"], str):
                e["date"] = str(e["date"])

        logging.info(f"serial history fetched for {serial_number}: {len(events)} event(s)")
        return {"message": "serial history", "serial_number": serial_number, "events": events}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"serial history lookup failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def productTypeLabelPy(product_type):
    labels = {"product": "Product", "accessories": "Accessory", "spare_parts": "Spare Part",
              "service_parts": "Service Part", "damaged": "Damaged Product"}
    return labels.get(product_type, product_type or "Product")


@app.get("/inventory/available_serials")
def available_serials(product_id: str, model_no: str = "", product_name: str = "", product_type: str = "", user: dict = Depends(require_role("admin", "accounts"))):
    """
    Lists every serial number currently on file for product_id (scoped to
    model_no when one is given), oldest lot first — same order the allocator
    uses. Powers the order review step's serial-number picker: the first
    `quantity` entries are what auto-allocation would pick by default, and the
    full list is what's available to switch to instead.
    """
    try:
        db = inventory_manager()
        serials = _unsold_serials(db.list_available_serials(INVENTORY_COLLECTION, product_id, model_no=model_no or None,
                                                      product_name=product_name or None, product_type=product_type or None))
        return {"message": "available serial numbers", "serial_numbers": serials}
    except Exception as e:
        logging.error("fetching available serial numbers failed!")
        raise HTTPException(status_code=500, detail="available serial numbers cannot be fetched")


@app.get("/inventory/serial_search")
def serial_search(q: str, limit: int = 10, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    term = (q or "").strip()
    if len(term) < 3:
        return {"results": []}
    limit = max(1, min(int(limit or 10), 25))
    try:
        needle = term.lower()
        lots = inventory_manager().get_data(
            collection_name=INVENTORY_COLLECTION,
            query={"serial_numbers": {"$regex": re.escape(term), "$options": "i"},
                   "quantity": {"$gt": 0},
                   "product_type": {"$nin": ["damaged", "spare_parts", "service_parts"]}})
        lots.sort(key=lambda e: e.get("purchase_date") or "")
        found, seen = [], set()
        for lot in lots:
            for sn in (lot.get("serial_numbers") or []):
                if needle in str(sn).lower() and sn not in seen:
                    seen.add(sn)
                    found.append({"serial_number": sn, "product_id": lot.get("product_id"),
                                  "product_name": lot.get("product_name"), "model_no": lot.get("model_no") or "",
                                  "price": lot.get("price") or 0, "tax_rate": lot.get("tax_rate") or 0,
                                  "lot_no": lot.get("lot_no") or ""})
        found.sort(key=lambda r: (0 if str(r["serial_number"]).lower() == needle else 1, str(r["serial_number"])))
        found = found[:limit * 3]
        free = set(_unsold_serials([r["serial_number"] for r in found]))
        return {"results": [r for r in found if r["serial_number"] in free][:limit]}
    except Exception as e:
        logging.error(f"serial search failed: {e}")
        raise HTTPException(status_code=500, detail="serial search failed")


def _unit_price(request):
    try:
        return float(str(request.price or 0).replace(",", "").strip() or 0)
    except ValueError:
        return 0


def _record_purchase_on_customer(request, user):
    """
    Called after a product lot is added to inventory. The supplier company is a
    row in the customers collection (same schema orders use): matched by company
    name (case-insensitive), or created from the details typed in the form.
    Every purchase is appended to customer["purchases"] so it shows in that
    party's history; purchases made on CREDIT also count towards "Returned" on
    the users page (we owe them / it reduces what they owe us).
    Returns None when nothing applies, else a small status dict.
    """
    try:
        name = (request.supplier or "").strip()
        mode = (request.payment_mode or "").strip().lower()
        if not name or mode not in ("paid", "partial", "credit"):
            return None
        unit_price = _unit_price(request)
        amount = round(unit_price * int(request.quantity or 0) * (1 + float(request.tax_rate or 0) / 100), 2)
        if amount <= 0:
            return None

        db = customer_manager()
        match = next((c for c in db.get_data(collection_name=CUSTOMER_COLLECTION, query={})
                      if (c.get("company_name") or "").strip().lower() == name.lower()), None)
        created = False
        if match is None:
            new_customer = customer_manager(
                company_name=name,
                company_address=(request.supplier_address or "").strip(),
                gst_number=(request.supplier_gst or "").strip(),
                contractor_person=(request.supplier_contact_person or "").strip(),
                contractor_number=(request.supplier_contact_number or "").strip(),
                contractor_email=(request.supplier_contact_email or "").strip(),
            )
            new_customer.add(collection_name=CUSTOMER_COLLECTION)
            db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                           update_values={"credit_limit": 0, "credit_used": 0, "created_by": user["username"]})
            customer_id, purchases = new_customer.customer_id, []
            created = True
        else:
            customer_id, purchases = match["customer_id"], list(match.get("purchases") or [])

        purchases.append({
            "purchase_id": str(uuid.uuid4()),
            "date": request.purchase_date or datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "product_name": request.product_name,
            "product_id": request.product_id,
            "model_no": request.model_no,
            "quantity": request.quantity,
            "unit_price": unit_price,
            "tax_rate": request.tax_rate,
            "amount": amount,
            **_purchase_record_payment(mode, amount, request.paid_amount, request.credit_days,
                                       request.purchase_date or datetime.now(timezone.utc).strftime("%Y-%m-%d")),
            "lot_no": request.lot_no,
            "added_by": user["username"],
            "added_at": datetime.now(timezone.utc).isoformat(),
        })
        db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id},
                       update_values={"purchases": purchases})
        return {"customer_id": customer_id, "amount": amount, "payment_mode": mode, "customer_created": created}
    except Exception:
        logging.error("recording purchase on customer ledger failed!")
        return {"error": "inventory saved, but the customer ledger entry could not be recorded"}


@app.get("/customer/company_list")
def company_list(user: dict = Depends(require_role("service_manager", "admin", "accounts", "inventory_manager"))):
    """Light list (no credit/financial data) used by the inventory form's company picker."""
    try:
        db = customer_manager()
        rows = db.get_data(collection_name=CUSTOMER_COLLECTION, query={})
        keep = ("customer_id", "company_name", "company_address", "gst_number",
                "contractor_person", "contractor_number", "contractor_email")
        dataset = sorted(({k: r.get(k, "") for k in keep} for r in rows if r.get("company_name")),
                         key=lambda r: r["company_name"].lower())
        return {"message": "company list", "dataset": dataset}
    except Exception:
        logging.error("company list cannot be fetched")
        raise HTTPException(status_code=500, detail="company list cannot be fetched")


def _norm_serial(value) -> str:
    return str(value or "").strip().lower()


def _assert_unique_product_serials(serials, exclude_lot_id=None, ignore_on_lot=None, ignore_serials=None):
    """
    Backend duplicate-serial guard for product_type "product" (the only category
    where a serial number identifies one physical unit). Runs on every path that
    puts serial numbers into inventory — manual typing, Excel upload, auto
    generation, assembly approval — so the frontend check is no longer the only
    line of defence.

    Rejects (HTTP 400):
      * blank serials,
      * the same serial twice inside the request (case-insensitive, whitespace ignored),
      * any serial already on a "product" lot in inventory (case-insensitive).

    exclude_lot_id  - a lot whose serial list is being REPLACED by this request,
                      so its own current serials don't count as clashes.
    ignore_on_lot / ignore_serials
                    - serials being pulled off lot `ignore_on_lot` in this same
                      request (removed / marked faulty), so a serial can be
                      taken off and put back in one save.
    """
    cleaned = [str(s).strip() for s in (serials or []) if s is not None]
    if not cleaned:
        return
    if any(not c for c in cleaned):
        raise HTTPException(status_code=400, detail="serial numbers cannot be blank")

    seen, repeated = set(), []
    for c in cleaned:
        k = c.lower()
        if k in seen and c not in repeated:
            repeated.append(c)
        seen.add(k)
    if repeated:
        raise HTTPException(status_code=400,
                            detail=f"duplicate serial number(s) in this request: {', '.join(repeated[:10])}")

    ignore = set(ignore_serials or [])
    lots = inventory_manager().get_data(
        collection_name=INVENTORY_COLLECTION,
        query={"product_type": {"$in": ["product", None]}, "serial_numbers.0": {"$exists": True}},
    )
    clashes = []
    for lot in lots:
        lot_id = str(lot.get("_id"))
        if exclude_lot_id is not None and lot_id == str(exclude_lot_id):
            continue
        for sn in lot.get("serial_numbers") or []:
            k = _norm_serial(sn)
            if k not in seen:
                continue
            if ignore_on_lot is not None and lot_id == str(ignore_on_lot) and k in ignore:
                continue
            clashes.append(str(sn).strip())
    if clashes:
        shown = list(dict.fromkeys(clashes))
        more = f" (+{len(shown) - 10} more)" if len(shown) > 10 else ""
        raise HTTPException(status_code=400,
                            detail=f"serial number(s) already exist in inventory: {', '.join(shown[:10])}{more}")


_ONCE_LOCK = threading.Lock()
_ONCE_DONE = {}
_ONCE_INFLIGHT = {}


def _run_once(scope, user, payload, fn, ttl=60):
    try:
        body = payload.model_dump() if hasattr(payload, "model_dump") else payload.dict()
    except Exception:
        body = str(payload)
    raw = json.dumps([scope, (user or {}).get("username"), body], sort_keys=True, default=str)
    key = hashlib.sha1(raw.encode()).hexdigest()
    now = time.time()
    with _ONCE_LOCK:
        for k in [k for k, v in _ONCE_DONE.items() if now - v[0] > ttl]:
            del _ONCE_DONE[k]
        hit = _ONCE_DONE.get(key)
        if hit:
            return hit[1]
        ev = _ONCE_INFLIGHT.get(key)
        owner = ev is None
        if owner:
            ev = threading.Event()
            _ONCE_INFLIGHT[key] = ev
    if not owner:
        ev.wait(60)
        with _ONCE_LOCK:
            hit = _ONCE_DONE.get(key)
        if hit:
            return hit[1]
        raise HTTPException(status_code=409, detail="same request was already in progress, check inventory before retrying")
    try:
        result = fn()
        with _ONCE_LOCK:
            _ONCE_DONE.clear()
            _ONCE_DONE[key] = (time.time(), result)
        return result
    finally:
        with _ONCE_LOCK:
            _ONCE_INFLIGHT.pop(key, None)
        ev.set()


def _id_query(item_id):
    try:
        return {"_id": {"$in": [ObjectId(item_id), item_id]}}
    except Exception:
        return {"_id": item_id}


def _find_lot(item_id, extra=None):
    q = _id_query(item_id)
    if extra:
        q = {**q, **extra}
    return mongodbclient().database[INVENTORY_COLLECTION].find_one(q)


def _type_group(product_type):
    return {"$in": ["product", None]} if (product_type or "product") == "product" else product_type


def _assert_model_free(model_no, product_name, product_type, exclude_id=None):
    # blocks ONLY when product name AND model no are BOTH the same as an existing lot
    # (case-insensitive, ignoring leading/trailing spaces). Same model with a different
    # product name, or same product name with a different model, is allowed.
    model = str(model_no or "").strip()
    name = str(product_name or "").strip()
    if not model or not name:
        return
    q = {
        "model_no": {"$regex": f"^{re.escape(model)}$", "$options": "i"},
        "product_name": {"$regex": f"^\\s*{re.escape(name)}\\s*$", "$options": "i"},
        "product_type": _type_group(product_type),
    }
    if exclude_id is not None:
        q["_id"] = {"$ne": exclude_id}
    hit = mongodbclient().database[INVENTORY_COLLECTION].find_one(q, {"product_name": 1})
    if hit:
        raise HTTPException(status_code=409,
                            detail=f"product '{name}' with model no '{model}' already exists in inventory")


def _assert_serials_free(serials, product_type, exclude_id=None):
    cleaned = [str(s).strip() for s in (serials or []) if s is not None and str(s).strip()]
    if not cleaned:
        return
    keys = [_norm_serial(c) for c in cleaned]
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=400, detail="duplicate serial numbers in this request")
    variants = list({v for c in cleaned for v in (c, c.lower(), c.upper())})
    q = {"serial_numbers": {"$in": variants}}
    if exclude_id is not None:
        q["_id"] = {"$ne": exclude_id}
    new_type = (product_type or "product")
    clashes = []
    for lot in mongodbclient().database[INVENTORY_COLLECTION].find(q, {"serial_numbers": 1, "product_type": 1}):
        holder = lot.get("product_type") or "product"
        if holder != new_type and (holder == "damaged" or new_type == "damaged"):
            continue
        for sn in lot.get("serial_numbers") or []:
            if _norm_serial(sn) in keys:
                clashes.append(str(sn).strip())
    if clashes:
        shown = list(dict.fromkeys(clashes))
        raise HTTPException(status_code=409,
                            detail=f"serial number(s) already exist in inventory: {', '.join(shown[:10])}")


@app.post("/inventory/create")
def create_inventory(request: InventoryRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "inventory_manager"))):
    return _run_once("create", user, request, lambda: _create_inventory_impl(request, user))


def _create_inventory_impl(request: InventoryRequest, user: dict):
    try:
        _validate_payment(request.payment_mode,
                          round(_unit_price(request) * int(request.quantity or 0) * (1 + float(request.tax_rate or 0) / 100), 2),
                          request.paid_amount, request.credit_days)
        # serial numbers are optional for accessories / spare_parts / service_parts —
        # only enforce the quantity match when at least one serial number was actually given
        if request.product_type in ("spare_parts", "service_parts", "accessories"):
            if not (request.supplier or "").strip():
                raise HTTPException(status_code=400, detail="company name is required")
            if not (request.invoice_no or "").strip():
                raise HTTPException(status_code=400, detail="invoice number is required")
        serial_optional_types = ("accessories", "spare_parts", "service_parts")
        serials_required = request.product_type not in serial_optional_types or len(request.serial_numbers) > 0
        if serials_required and len(request.serial_numbers) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match quantity")
        # duplicate-serial guard only ever applies to product_type "product" —
        # every other category (accessories, spare parts, service parts,
        # damaged) is allowed to reuse a serial number, including one already
        # on file elsewhere (e.g. a unit moving into "damaged" under the
        # serial it already had as a normal product).
        if request.product_type == "product" and len(set(request.serial_numbers)) != len(request.serial_numbers):
            raise HTTPException(status_code=400, detail="serial numbers must be unique")
        if request.product_type == "product":
            _assert_unique_product_serials(request.serial_numbers)
        if request.product_type in ("product", "accessories"):
            _assert_model_free(request.model_no, request.product_name, request.product_type)
        if request.product_type not in ("spare_parts", "service_parts"):
            _assert_serials_free(request.serial_numbers, request.product_type)

        if request.product_type in ("spare_parts", "service_parts"):
            if not request.parent_product_name.strip():
                raise HTTPException(status_code=400, detail="product name (the part belongs to) is required")
            if request.product_type == "service_parts" and request.part_category not in ("purchase", "warranty"):
                raise HTTPException(status_code=400, detail="select purchase or warranty for a service part")
            holograms = [h.strip() for h in request.hologram_numbers if h and h.strip()]
            if len(holograms) > request.quantity:
                raise HTTPException(status_code=400, detail="hologram numbers cannot outnumber the quantity")
            # hologram numbers only ever belong to spare_parts/service_parts —
            # never to product_type "product" — and the duplicate guard is
            # reserved for that category alone, so parts are always allowed to
            # reuse a hologram number already on file or repeated in this batch.
            part = inventory_manager(
                product_name=request.product_name.strip(),
                quantity=request.quantity,
                purchase_date=request.purchase_date,
                lot_no=request.lot_no,
                supplier=request.supplier,
                supplier_address=request.supplier_address,
                invoice_no=request.invoice_no,
                price=request.price or 0,
                tax_rate=request.tax_rate,
                product_type=request.product_type,
                warranty_until=request.warranty_until,
                parent_product_name=request.parent_product_name.strip(),
                part_category=request.part_category if request.product_type == "service_parts" else None,
                hologram_numbers=holograms,
                created_by=user["username"],
            )
            part.add_part(collection_name=INVENTORY_COLLECTION)
            resp = {"message": "part was listed successfully"}
            ledger = _record_purchase_on_customer(request, user)
            if ledger:
                resp["ledger"] = ledger
            return resp

        inventory_item = inventory_manager(
            product_name=request.product_name,
            product_id=request.product_id,
            quantity=request.quantity,
            purchase_date=request.purchase_date,
            lot_no=request.lot_no,
            supplier=request.supplier,
            price=request.price,
            tax_rate=request.tax_rate,
            model_no=request.model_no,
            supplier_address=request.supplier_address,
            invoice_no=request.invoice_no,
            serial_numbers=request.serial_numbers,
            product_type=request.product_type,
            warranty_until=(request.warranty_until or None) if request.product_type == "damaged" else None,
            reason=request.reason if request.product_type == "damaged" else "",
            created_by=user["username"],
        )
        inventory_item.add_or_merge(collection_name=INVENTORY_COLLECTION)
        logging.info("product listed successfully on inventory")

        # purchase -> customer ledger (users page > Customers). Inventory is already
        # saved at this point, so a ledger problem is reported back, not raised.
        ledger = _record_purchase_on_customer(request, user)
        resp = {"message": "product was listed successfully"}
        if ledger:
            resp["ledger"] = ledger
        return resp

    except HTTPException:
        raise
    except Exception as e:
        logging.error("product cannot be listed to the inventory")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/inventory/update/{item_id}")
def update_inventory(item_id: str, request: InventoryUpdateRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts", "inventory_manager"))):
    return _run_once("update:" + item_id, user, request, lambda: _update_inventory_impl(item_id, request, user))


def _update_inventory_impl(item_id: str, request: InventoryUpdateRequest, user: dict):
    try:
        db = inventory_manager()
        lot = _find_lot(item_id)
        if not lot:
            raise HTTPException(status_code=404, detail="product not found")
        existing = [lot]
        match_query = {"_id": lot["_id"]}
        product_id = lot.get("product_id", "")
        current_serials = existing[0].get("serial_numbers") or []
        current_type = existing[0].get("product_type", "product")

        updated_values = dict(request.updated_values)
        # track who last touched this lot — same idea as an order's creator,
        # shown on the inventory table/view so edits are attributable
        updated_values["updated_by"] = user["username"]
        raw_effective_type = updated_values.get("product_type", current_type)
        # normalize (lowercase + strip) so a stray case/whitespace mismatch — or a
        # request that omits product_type — can never make an accessories/spare_parts/
        # service_parts lot fall through to the strict "quantity must equal serial
        # count" check below. Falls back to the type already on file if the request's
        # value doesn't normalize to anything meaningful.
        effective_type = (str(raw_effective_type or "").strip().lower()) or str(current_type or "product").strip().lower()

        SERIAL_OPTIONAL_TYPES = ("accessories", "spare_parts", "service_parts")

        # Both a straight removal (write-off, gone from stock entirely) and a
        # "mark faulty" (pulled off this lot but pushed into the Damaged
        # Product category instead of discarded — handled further down)
        # take the unit off THIS lot the same way, so they're combined here
        # for that part. Kept as two separate request fields so the faulty
        # ones can still be told apart afterwards for the damaged-category push.
        pulled_off_serials = set(request.remove_serial_numbers or []) | set(request.faulty_serial_numbers or [])

        _final_name = updated_values.get("product_name", existing[0].get("product_name", ""))
        _final_model = updated_values.get("model_no", existing[0].get("model_no", "")) or ""
        _cur_type = str(current_type or "product").strip().lower()
        if effective_type in ("product", "accessories") and str(_final_model).strip() and (
            _norm_serial(_final_model) != _norm_serial(existing[0].get("model_no"))
            or _norm_serial(_final_name) != _norm_serial(existing[0].get("product_name"))
            or effective_type != _cur_type
        ):
            _assert_model_free(_final_model, _final_name, effective_type, exclude_id=existing[0]["_id"])
        _explicit_serials = updated_values.get("serial_numbers")
        _incoming = list(request.new_serial_numbers or []) + (list(_explicit_serials) if isinstance(_explicit_serials, list) else [])
        if _incoming and effective_type not in ("spare_parts", "service_parts"):
            _assert_serials_free(_incoming, effective_type, exclude_id=existing[0]["_id"])

        # ---- backend duplicate-serial guard (product category only) ----
        # Any serial that would end up on a "product" lot — newly added ones,
        # an explicit serial_numbers list in updated_values, or the existing
        # serials of a lot being converted into a "product" — must not already
        # exist on another product lot (or repeat inside this request).
        if effective_type == "product":
            _lot_id = existing[0].get("_id")
            _removed = {_norm_serial(x) for x in pulled_off_serials}
            if request.new_serial_numbers:
                _assert_unique_product_serials(request.new_serial_numbers, ignore_on_lot=_lot_id, ignore_serials=_removed)
            _explicit = updated_values.get("serial_numbers")
            if isinstance(_explicit, list) and _explicit:
                _assert_unique_product_serials(_explicit, exclude_lot_id=_lot_id)
            if str(current_type or "product").strip().lower() != "product" and current_serials:
                _assert_unique_product_serials(current_serials, exclude_lot_id=_lot_id)

        # serial numbers are optional for accessories / spare_parts / service_parts,
        # so quantity is free to move independently of the serial list for those
        # types — only sync serials with quantity for product/damaged
        if effective_type in SERIAL_OPTIONAL_TYPES or str(current_type or "").strip().lower() in SERIAL_OPTIONAL_TYPES:
            # serial numbers are optional here and this branch is never
            # product_type "product", so the duplicate-serial guard (reserved
            # for "product" only) doesn't apply — accessories/spare/service
            # parts may reuse a serial number already on file or repeated
            # within this batch.
            serials = list(current_serials)
            if pulled_off_serials:
                serials = [s for s in serials if s not in pulled_off_serials]
            if request.new_serial_numbers:
                serials = serials + request.new_serial_numbers
            if pulled_off_serials or request.new_serial_numbers:
                updated_values["serial_numbers"] = serials

        # whenever quantity changes, keep serial_numbers in sync instead of letting
        # them silently drift out of step with the stock count
        elif "quantity" in updated_values and updated_values["quantity"] is not None:
            new_quantity = int(updated_values["quantity"])
            serials = list(current_serials)

            if pulled_off_serials:
                missing = [s for s in pulled_off_serials if s not in serials]
                if missing:
                    raise HTTPException(status_code=400,
                                         detail=f"serial number(s) not found on this product: {', '.join(missing)}")
                serials = [s for s in serials if s not in pulled_off_serials]

            if request.new_serial_numbers:
                # duplicate-serial guard only ever applies to product_type
                # "product" — a "damaged" item is allowed to reuse a serial
                # number already on file (e.g. a unit moving into "damaged"
                # under the serial it already had as a normal product).
                if effective_type == "product":
                    if len(set(request.new_serial_numbers)) != len(request.new_serial_numbers):
                        raise HTTPException(status_code=400, detail="new serial numbers must be unique")
                    duplicates = [s for s in request.new_serial_numbers if s in serials]
                    if duplicates:
                        raise HTTPException(status_code=400,
                                             detail=f"serial number(s) already exist on this product: {', '.join(duplicates)}")
                serials = serials + request.new_serial_numbers

            if len(serials) != new_quantity:
                if new_quantity > len(serials):
                    raise HTTPException(
                        status_code=400,
                        detail=f"quantity is {new_quantity} but only {len(serials)} serial number(s) provided — "
                               f"add {new_quantity - len(serials)} more serial number(s)"
                    )
                raise HTTPException(
                    status_code=400,
                    detail=f"quantity is {new_quantity} but {len(serials)} serial number(s) are on file — "
                           f"remove {len(serials) - new_quantity} serial number(s)"
                )

            updated_values["serial_numbers"] = serials

        # hologram numbers are tracked per-unit (one per quantity) for spare_parts /
        # service_parts, separate from serial numbers. Each is added up to however many
        # slots remain (quantity - hologram numbers already on file); anything beyond
        # that is handed back as "leftover" so the caller can show a popup and let the
        # user export the unused ones instead of silently dropping or over-filling.
        hologram_added = 0
        hologram_leftover: list[str] = []
        if effective_type in ("spare_parts", "service_parts") and (
            request.new_hologram_numbers or request.remove_hologram_numbers or "quantity" in updated_values
        ):
            current_hologram = existing[0].get("hologram_numbers")
            if current_hologram is None:
                legacy = existing[0].get("hologram_no")
                current_hologram = [legacy] if legacy else []
            else:
                current_hologram = list(current_hologram)

            if request.remove_hologram_numbers:
                current_hologram = [h for h in current_hologram if h not in request.remove_hologram_numbers]

            if request.new_hologram_numbers:
                incoming = [h.strip() for h in request.new_hologram_numbers if h and h.strip()]
                # hologram numbers only ever belong to spare_parts/service_parts
                # (never product_type "product"), and the duplicate guard is
                # reserved for that category alone — so reuse/repeats are
                # always allowed here.
                effective_quantity = int(updated_values.get("quantity", existing[0].get("quantity", 0)) or 0)
                remaining_slots = max(0, effective_quantity - len(current_hologram))
                to_add = incoming[:remaining_slots]
                hologram_leftover = incoming[remaining_slots:]
                hologram_added = len(to_add)
                current_hologram = current_hologram + to_add

            # never let hologram numbers on file outnumber the quantity (e.g. quantity
            # was reduced) — trim from the end rather than leaving a stale mismatch
            effective_quantity = int(updated_values.get("quantity", existing[0].get("quantity", 0)) or 0)
            if len(current_hologram) > effective_quantity:
                current_hologram = current_hologram[:effective_quantity]

            updated_values["hologram_numbers"] = current_hologram
            updated_values.pop("hologram_no", None)  # migrated to hologram_numbers list

        # Faulty units pulled off this lot (folded into pulled_off_serials
        # above, alongside plain removals) get pushed into the Damaged
        # Product category instead of just being discarded — merges into an
        # existing damaged entry for the same product_id+model_no, or
        # creates one, same pattern used when an order return comes back
        # faulty. Uses the lot's ORIGINAL product_id/product_name/model_no
        # (from `existing`, before this same request's own rename, if any) —
        # these are the exact physical units that were on file under that
        # identity.
        if request.faulty_serial_numbers:
            src_product_id = existing[0].get("product_id", product_id)
            src_product_name = existing[0].get("product_name", "")
            src_model_no = existing[0].get("model_no", "") or ""
            damage_reason = "marked faulty during inventory edit"
            existing_damaged = db.get_data(
                collection_name=INVENTORY_COLLECTION,
                query={"product_id": src_product_id, "model_no": src_model_no, "product_type": "damaged"}
            )
            if existing_damaged:
                entry = existing_damaged[0]
                merged_serials = (entry.get("serial_numbers") or []) + list(request.faulty_serial_numbers)
                new_damaged_quantity = int(entry.get("quantity", 0) or 0) + len(request.faulty_serial_numbers)
                db.update(
                    collection_name=INVENTORY_COLLECTION,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": merged_serials, "quantity": new_damaged_quantity, "reason": damage_reason}
                )
            else:
                inventory_manager(
                    product_name=src_product_name,
                    product_id=src_product_id,
                    quantity=len(request.faulty_serial_numbers),
                    model_no=src_model_no,
                    serial_numbers=list(request.faulty_serial_numbers),
                    product_type="damaged",
                    reason=damage_reason,
                ).add(collection_name=INVENTORY_COLLECTION)

        write_result = db.update(collection_name=INVENTORY_COLLECTION, query=match_query,
                                  update_values=updated_values)
        touched = getattr(write_result, "matched_count", None)
        if touched is None:
            touched = getattr(write_result, "deleted_count", 1)
        if touched == 0:
            raise HTTPException(status_code=409, detail="this product was changed or removed by someone else, refresh and try again")
        logging.info("inventory was updated")
        return {
            "message": "inventory was updated successfully",
            "id": item_id,
            "product_id": product_id,
            "hologram_added": hologram_added,
            "hologram_leftover": hologram_leftover
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error("inventory updation was unsuccessful!")
        raise HTTPException(status_code=500, detail="inventory cannot be updated")


@app.post("/inventory/delete/{item_id}")
def delete_product(item_id: str, user: dict = Depends(require_role("admin"))):
    return _run_once("delete:" + item_id, user, {"id": item_id}, lambda: _delete_product_impl(item_id))


def _delete_product_impl(item_id: str):
    try:
        db = inventory_manager()
        lot = _find_lot(item_id)
        if not lot:
            raise HTTPException(status_code=404, detail="product not found")
        del_result = db.delete_data(collection_name=INVENTORY_COLLECTION, query={"_id": lot["_id"]})
        if getattr(del_result, "deleted_count", 1) == 0:
            raise HTTPException(status_code=409, detail="this product was already removed, refresh and try again")
        logging.info(f"product was deleted successfully from the inventory {item_id}")
        return {"message": "product deletion was successful", "id": item_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("product deletion was failed!")
        raise HTTPException(status_code=500, detail="product cannot be deleted")


@app.post("/inventory/repair/{item_id}")
def repair_damaged_product(item_id: str, user: dict = Depends(require_role("service_manager", "admin", "accounts", "inventory_manager"))):
    return _run_once("repair:" + item_id, user, {"id": item_id}, lambda: _repair_damaged_product_impl(item_id, user))


def _repair_damaged_product_impl(item_id: str, user: dict):
    """Action button on the Damaged Product row (replaces Delete there).

    - If the damaged entry is a full PRODUCT (it carries serial numbers,
      just like a normal product entry) -> a new service record is opened
      for it with issue="Inhouse Warranty", so it flows into the Service
      page for in-house repair tracking.
    - If it's a PART (no serial numbers - e.g. one swapped out during a
      service and filed as damaged via its hologram number) -> it isn't
      serviceable in-house, so it's simply flagged in the damaged row's
      Status column as "Send to Parent Company" instead.
    """
    try:
        db = inventory_manager()
        item = _find_lot(item_id, {"product_type": "damaged"})
        if not item:
            raise HTTPException(status_code=404, detail="damaged product not found")

        is_product = bool(item.get("serial_numbers"))

        if is_product:
            serial_no = item["serial_numbers"][0] if item.get("serial_numbers") else ""
            svc = service_detail(product_id=item.get("product_id", ""), serial_no=serial_no)
            svc.add_service(
                collection_name=SERVICE_COLLECTION,
                technician_id="",
                purchase_date=item.get("purchase_date", ""),
                issue="Inhouse Warranty",
                image="",
                video="",
                location="indoor",
                spare_parts="",
                created_by=user["username"],
                product_name=item.get("product_name", ""),
                model_no=item.get("model_no", "")
            )
            db.update(collection_name=INVENTORY_COLLECTION, query={"_id": item["_id"]},
                      update_values={"damage_status": "Sent for Repair (Inhouse Warranty)"})
            logging.info(f"damaged product {item_id} sent for in-house repair, service {svc.service_id} created")
            return {"message": "sent for in-house warranty repair", "mode": "product", "service_id": svc.service_id}
        else:
            db.update(collection_name=INVENTORY_COLLECTION, query={"_id": item["_id"]},
                      update_values={"damage_status": "Send to Parent Company"})
            logging.info(f"damaged part {item_id} marked to send to parent company")
            return {"message": "marked to send to parent company", "mode": "part"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("repair action on damaged product failed!")
        raise HTTPException(status_code=500, detail="repair action failed")


@app.get("/customer/")
def customers(user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        if user["role"] in ("admin", "accounts"):
            dataset = db.get_data(collection_name=CUSTOMER_COLLECTION, query={})
        elif user["role"] == "distributor":
            acc_db = login()
            team = acc_db.get_data(ACCOUNTS_COLLECTION, query={"role": "distributor", "manager": user["username"]})
            visible_usernames = [user["username"]] + [m["username"] for m in team]
            dataset = db.get_data(collection_name=CUSTOMER_COLLECTION, query={"created_by": {"$in": visible_usernames}})
        else:
            dataset = []
        logging.info("customer dataset was fetched successfully")
        return {"message": "customer dataset", "dataset": dataset}
    except Exception as e:
        logging.error("customer dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="customer dataset cannot be fetched")


@app.get("/customer/search")
def search_customer(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        dataset = db.search(collection_name=CUSTOMER_COLLECTION, term=term) if term else db.get_data(CUSTOMER_COLLECTION, query={})
        if user["role"] == "distributor":
            # a distributor should only see customers they themselves created —
            # not customers created by other salespeople on their team
            dataset = [c for c in dataset if c.get("created_by") == user["username"]]
        return {"message": "customer search results", "dataset": dataset}
    except Exception as e:
        logging.error("customer search failed")
        raise HTTPException(status_code=500, detail="customer search failed")


@app.post("/customer/create")
def create_customer(request: CustomerRequest, user: dict = Depends(require_role("admin", "accounts", "distributor", "inventory_manager"))):
    try:
        new_customer = customer_manager(
            company_name=request.company_name,
            company_address=request.company_address,
            gst_number=request.gst_number,
            contractor_person=request.contractor_person,
            contractor_number=request.contractor_number,
            contractor_email=request.contractor_email,
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)

        customer_db = customer_manager()
        customer_db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                 update_values={"credit_limit": request.credit_limit, "credit_used": 0, "created_by": user["username"]})

        logging.info("customer created successfully")
        return {
            "message": "customer created successfully",
            "customer_id": new_customer.customer_id,
            "customer": {
                "customer_id": new_customer.customer_id,
                "company_name": new_customer.company_name,
                "company_address": new_customer.company_address,
                "gst_number": new_customer.gst_number,
                "contractor_person": new_customer.contractor_person,
                "contractor_number": new_customer.contractor_number,
                "contractor_email": new_customer.contractor_email,
                "credit_limit": request.credit_limit,
                "credit_used": 0,
                "created_by": user["username"],
            }
        }
    except Exception as e:
        logging.error("customer creation failed!")
        raise HTTPException(status_code=500, detail="customer creation failed")


@app.post("/customer/update/{customer_id}")
def update_customer(customer_id: str, request: CustomerUpdateRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        db = customer_manager()
        result = db.update(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id},
                            update_values=request.updated_values)
        if result.matched_count == 0:
            raise HTTPException(status_code=404, detail="no customer found with this id")
        logging.info("customer was updated")
        return {"message": "customer updated successfully", "customer_id": customer_id,
                "updated_value": request.updated_values}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("customer updation was unsuccessful!")
        raise HTTPException(status_code=500, detail="customer cannot be updated")


@app.post("/customer/add_return/{customer_id}")
def add_customer_return(customer_id: str, request: CustomerReturnRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        if request.amount <= 0:
            raise HTTPException(status_code=400, detail="return amount must be greater than zero")
        db = customer_manager()
        found = db.get_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not found:
            raise HTTPException(status_code=404, detail="no customer found with this id")
        returns = list(found[0].get("returns") or [])
        returns.append({
            "amount": request.amount,
            "note": (request.note or "").strip(),
            "return_date": request.return_date or datetime.now(timezone.utc).isoformat(),
            "added_by": user["username"],
            "added_at": datetime.now(timezone.utc).isoformat()
        })
        db.update(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id},
                  update_values={"returns": returns})
        return {"message": "return added", "customer_id": customer_id}
    except HTTPException:
        raise
    except Exception:
        logging.error("adding customer return failed!")
        raise HTTPException(status_code=500, detail="return could not be added")


class PurchasePaymentRequest(BaseModel):
    amount: float
    note: str = ""
    payment_date: str = ""


@app.post("/customer/purchase_payment/{customer_id}/{purchase_id}")
def add_purchase_payment(customer_id: str, purchase_id: str, request: PurchasePaymentRequest,
                         user: dict = Depends(require_role("admin", "accounts"))):
    """Records a later payment against the unpaid balance of a credit / partial purchase."""
    try:
        if request.amount <= 0:
            raise HTTPException(status_code=400, detail="payment amount must be greater than zero")
        db = customer_manager()
        found = db.get_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not found:
            raise HTTPException(status_code=404, detail="no customer found with this id")
        purchases = list(found[0].get("purchases") or [])
        target = next((p for p in purchases if p.get("purchase_id") == purchase_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="no purchase found with this id")
        amount = float(target.get("amount") or 0)
        if (target.get("payment_mode") or "paid") == "paid":
            raise HTTPException(status_code=400, detail="this purchase is already fully paid")
        # legacy credit rows have no paid_amount -> nothing was paid up front
        paid_before = float(target.get("paid_amount") or 0) + sum(float(x.get("amount") or 0) for x in (target.get("payments") or []))
        balance = round(amount - paid_before, 2)
        if request.amount > balance + 0.005:
            raise HTTPException(status_code=400, detail=f"payment is more than the pending balance (Rs {balance})")
        payments = list(target.get("payments") or [])
        payments.append({
            "amount": round(request.amount, 2),
            "note": (request.note or "").strip(),
            "payment_date": request.payment_date or datetime.now(timezone.utc).isoformat(),
            "added_by": user["username"],
            "added_at": datetime.now(timezone.utc).isoformat(),
        })
        target["payments"] = payments
        db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id}, update_values={"purchases": purchases})
        return {"message": "payment recorded", "balance": round(balance - request.amount, 2)}
    except HTTPException:
        raise
    except Exception:
        logging.error("recording purchase payment failed!")
        raise HTTPException(status_code=500, detail="payment could not be recorded")


@app.post("/customer/add_debit/{customer_id}")
def add_customer_debit(customer_id: str, request: CustomerReturnRequest, user: dict = Depends(require_role("admin", "accounts"))):
    """Adds a manual Debit entry for a company (counts towards its Debit total).
    Credit entries (formerly 'returns') are still added via /customer/add_return/{customer_id}."""
    try:
        if request.amount <= 0:
            raise HTTPException(status_code=400, detail="debit amount must be greater than zero")
        db = customer_manager()
        found = db.get_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not found:
            raise HTTPException(status_code=404, detail="no customer found with this id")
        debits = list(found[0].get("debits") or [])
        debits.append({
            "amount": request.amount,
            "note": (request.note or "").strip(),
            "debit_date": request.return_date or datetime.now(timezone.utc).isoformat(),
            "added_by": user["username"],
            "added_at": datetime.now(timezone.utc).isoformat()
        })
        db.update(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id},
                  update_values={"debits": debits})
        return {"message": "debit added", "customer_id": customer_id}
    except HTTPException:
        raise
    except Exception:
        logging.error("adding customer debit failed!")
        raise HTTPException(status_code=500, detail="debit could not be added")


@app.post("/customer/delete/{customer_id}")
def delete_customer(customer_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = customer_manager()
        db.delete(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        logging.info(f"customer was deleted successfully {customer_id}")
        return {"message": "customer deletion was successful", "customer_id": customer_id}
    except Exception as e:
        logging.error("customer deletion was failed!")
        raise HTTPException(status_code=500, detail="customer cannot be deleted")


@app.get("/salesperson/search")
def search_salesperson(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = sales_person_manager()
        dataset = db.search(collection_name=SALESPERSON_COLLECTION, term=term) if term else db.get_data(SALESPERSON_COLLECTION, query={})
        return {"message": "sales person search results", "dataset": dataset}
    except Exception as e:
        logging.error("sales person search failed")
        raise HTTPException(status_code=500, detail="sales person search failed")


@app.post("/salesperson/create")
def create_salesperson(request: SalesPersonRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        new_sp = sales_person_manager(
            name=request.name,
            company_name=request.company_name,
            address=request.address,
            contact_number=request.contact_number,
            email=request.email,
        )
        new_sp.add(collection_name=SALESPERSON_COLLECTION)
        return {
            "message": "sales person created successfully",
            "sales_person_id": new_sp.sales_person_id,
            "sales_person": {
                "sales_person_id": new_sp.sales_person_id,
                "name": new_sp.name,
                "company_name": new_sp.company_name,
                "address": new_sp.address,
                "contact_number": new_sp.contact_number,
                "email": new_sp.email,
            }
        }
    except Exception as e:
        logging.error("sales person creation failed!")
        raise HTTPException(status_code=500, detail="sales person creation failed")


@app.get("/service/active")
def active_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION,
                                       query={"status": {"$in": ["active", "in_progress"]}})
        return {"message": "active services", "dataset": dataset}
    except Exception as e:
        logging.error("fetching active services failed")
        raise HTTPException(status_code=500, detail="active services cannot be fetched")


@app.get("/service/available_hologram_parts")
def available_hologram_parts(user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    """
    Powers the "Update Status" -> Completed -> spare part swap form on the
    Service page: instead of letting the technician type a free-text new
    hologram number (which can typo/mismatch what's actually on file and
    silently create bad inventory data), this returns every service_parts
    entry that actually carries hologram numbers on file, grouped by part
    name, so the UI can offer a plain pick-list instead.
    """
    try:
        inv_db = inventory_manager()
        entries = inv_db.get_data(collection_name=INVENTORY_COLLECTION, query={"product_type": "service_parts"})
        pool = {}
        for entry in entries:
            holograms = entry.get("hologram_numbers") or []
            if not holograms:
                continue
            name = entry.get("product_name", "")
            if not name:
                continue
            pool.setdefault(name, set()).update(holograms)
        dataset = [{"part_name": name, "hologram_numbers": sorted(numbers)} for name, numbers in pool.items() if numbers]
        dataset.sort(key=lambda p: p["part_name"].lower())
        return {"message": "available hologram-tagged service parts", "dataset": dataset}
    except Exception as e:
        logging.error("fetching available hologram parts failed!")
        raise HTTPException(status_code=500, detail="could not fetch available hologram parts")


@app.get("/allocation/")
def allocations(user: dict = Depends(get_current_user)):
    try:
        run_in_background("purge_damage_images", purge_stale_damage_images)
        db = allocation_manager()
        # damage photos are base64 blobs — fetched on demand via /allocation/{id}/damage_image
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION, query={}, projection={"damage_report.image": 0})
        return {"message": "allocation dataset", "dataset": dataset}
    except Exception as e:
        logging.error("fetching allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


@app.post("/allocation/send_to_dispatch/{allocation_id}")
def send_allocation_to_dispatch(allocation_id: str, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        allocation = matches[0]

        if allocation.get("allocation_type") == "spare_part":
            raise HTTPException(status_code=400, detail="spare part allocations already appear in the dispatch queue automatically")
        if allocation.get("dispatch"):
            raise HTTPException(status_code=400, detail="this allocation has already been dispatched")
        if allocation.get("sent_to_dispatch"):
            raise HTTPException(status_code=400, detail="this allocation is already in the dispatch queue")

        db.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                        update_values={"sent_to_dispatch": True})
        logging.info(f"allocation {allocation_id} sent to dispatch queue")
        return {"message": "allocation sent to dispatch queue", "allocation_id": allocation_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("sending allocation to dispatch failed")
        raise HTTPException(status_code=500, detail="could not send allocation to dispatch")


@app.post("/allocation/report_damage/{allocation_id}")
def report_damage(allocation_id: str, request: DamageReportRequest, user: dict = Depends(require_role("admin", "accounts", "distributor", "service_manager"))):
    try:
        if not request.image:
            raise HTTPException(status_code=400, detail="a photo of the damaged product is required")
        if not request.issue or not request.issue.strip():
            raise HTTPException(status_code=400, detail="please specify the issue")

        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")

        allocation = matches[0]
        is_spare = allocation.get("allocation_type") == "spare_part"
        product_label = (
            f"{allocation.get('spare_part', {}).get('part_name', '')}"
            if is_spare else
            ", ".join(f"{i.get('product_name')} x{i.get('quantity')}" for i in allocation.get("items", []))
        )

        reported_at = datetime.now(timezone.utc).isoformat()
        email_sent = send_damage_report_email(
            allocation_id=allocation_id,
            product_label=product_label,
            issue=request.issue,
            image_data_url=request.image,
            reported_by=user["username"]
        )

        db.update_data(
            collection_name=ALLOCATION_COLLECTION,
            query={"allocation_id": allocation_id},
            update_values={
                "damage_report": {
                    "reported": True,
                    "issue": request.issue,
                    "image": request.image,
                    "image_purged": False,
                    "reported_by": user["username"],
                    "reported_at": reported_at,
                    "email_sent": email_sent
                }
            }
        )

        logging.info(f"damage reported for allocation {allocation_id} by {user['username']}")
        return {"message": "damage reported successfully", "allocation_id": allocation_id, "email_sent": email_sent}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"reporting damage failed: {e}")
        raise HTTPException(status_code=500, detail="damage report could not be saved")


@app.get("/allocation/{allocation_id}/damage_image")
def allocation_damage_image(allocation_id: str, user: dict = Depends(get_current_user)):
    try:
        docs = allocation_manager().get_data(collection_name=ALLOCATION_COLLECTION,
                                             query={"allocation_id": allocation_id},
                                             projection={"damage_report.image": 1})
        image = ((docs[0].get("damage_report") or {}).get("image")) if docs else None
        return {"image": image}
    except Exception:
        logging.error("fetching damage image failed")
        raise HTTPException(status_code=500, detail="damage image cannot be fetched")


@app.get("/allocation/mine")
def my_allocations(user: dict = Depends(require_role("distributor", "inventory_manager"))):
    try:
        db = allocation_manager()
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION,
                               query={"allocation_type": {"$in": ["demo_unit", "product"]}, "allocated_by": user["username"]},
                               projection={"damage_report.image": 0})
        return {"message": "my demo unit allocations", "dataset": dataset}
    except Exception as e:
        logging.error("fetching my allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


def _fulfill_demo_unit(customer_id: str, customer: dict, items: list, allocated_by: str):
    """Resolves/creates the customer, deducts stock + serials from inventory, and records
    the demo_unit allocation. Shared by the direct admin/accounts endpoint and by
    /request/approve/{request_id} when a distributor's request is approved."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product")

    customer_db = customer_manager()
    customer_snapshot = dict(customer or {})

    if customer_id:
        existing = customer_db.get_data(CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        if not existing:
            raise HTTPException(status_code=404, detail="selected customer not found")
        customer_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
    else:
        if not customer_snapshot.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")
        new_customer = customer_manager(
            company_name=customer_snapshot.get("company_name"),
            company_address=customer_snapshot.get("company_address"),
            gst_number=customer_snapshot.get("gst_number"),
            contractor_person=customer_snapshot.get("contractor_person"),
            contractor_number=customer_snapshot.get("contractor_number"),
            contractor_email=customer_snapshot.get("contractor_email"),
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)
        customer_db.update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                 update_values={"created_by": allocated_by})
        customer_snapshot = {
            "customer_id": new_customer.customer_id,
            "company_name": new_customer.company_name,
            "company_address": new_customer.company_address,
            "gst_number": new_customer.gst_number,
            "contractor_person": new_customer.contractor_person,
            "contractor_number": new_customer.contractor_number,
            "contractor_email": new_customer.contractor_email,
            "created_by": allocated_by,
        }

    inventory_db = inventory_manager()
    need_legacy = {}
    for item in items:
        k = _item_ident(item)
        need_legacy[k] = need_legacy.get(k, 0) + item["quantity"]
    for (name, model, ptype), qty in need_legacy.items():
        pid = next((i.get("product_id", "") for i in items if _item_ident(i) == (name, model, ptype)), "")
        sellable, skipped = _sellable_quantity(inventory_db, pid, model or None, product_name=name or None, product_type=ptype or None)
        if sellable < qty:
            raise HTTPException(status_code=400, detail=_stock_short_detail(name or pid, sellable, skipped))

    demo_items = []
    deducted = []
    try:
        for item in items:
            allocated_serials = _auto_pick_item(inventory_db, item)
            deducted.append((item, allocated_serials))
            demo_items.append({
                "product_id": item["product_id"],
                "product_name": item["product_name"],
                "quantity": item["quantity"],
                "serial_numbers": allocated_serials
            })

        allocation = allocation_manager(customer=customer_snapshot, items=demo_items, allocated_by=allocated_by)
        allocation.add(collection_name=ALLOCATION_COLLECTION)
    except Exception:
        _rollback_stock(inventory_db, deducted)
        raise
    logging.info(f"demo unit allocation {allocation.allocation_id} created for {allocated_by}")
    return allocation.allocation_id


def _user_snapshot(username: str) -> dict:
    """Snapshot of a registered system user, stored on allocations as `sales_person`."""
    acc = mongodbclient().get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
    if not acc:
        raise HTTPException(status_code=404, detail=f"user '{username}' not found")
    acc = acc[0]
    return {
        "sales_person_id": acc.get("username"),
        "username": acc.get("username"),
        "name": acc.get("name") or acc.get("username"),
        "role": acc.get("role"),
        "company_name": acc.get("company_name", ""),
        "address": "",
        "contact_number": acc.get("phone", ""),
        "email": acc.get("email", ""),
    }


def _fulfill_demo_request(items: list, requester: str, remarks: str, request_id: str):
    """Approved demo request: deduct stock and allocate straight to the requesting user.
    No customer/company details at this stage. One allocation document per unit."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product")
    snapshot = _user_snapshot(requester)
    inventory_db = inventory_manager()

    need = {}
    for item in items:
        key = _item_ident(item)
        need[key] = need.get(key, 0) + item["quantity"]
    # check EVERYTHING before deducting anything, using the same rules the allocator uses
    for (name, model_no, ptype), qty in need.items():
        pid = next((i.get("product_id", "") for i in items if _item_ident(i) == (name, model_no, ptype)), "")
        sellable, skipped = _sellable_quantity(inventory_db, pid, model_no or None, product_name=name or None, product_type=ptype or None)
        if sellable < qty:
            variant_note = f" (model {model_no})" if model_no else ""
            raise HTTPException(status_code=400, detail=_stock_short_detail(name or pid, sellable, skipped, variant_note))

    ids = []
    deducted = []
    try:
        for item in items:
            serials = _auto_pick_item(inventory_db, item)
            deducted.append((item, serials))
            for i in range(item["quantity"]):
                serial = serials[i] if i < len(serials) else None
                alloc = allocation_manager(
                    sales_person=snapshot,
                    items=[{"product_id": item["product_id"], "product_name": item["product_name"],
                            "model_no": item.get("model_no", ""), "quantity": 1,
                            "serial_numbers": [serial] if serial else []}],
                    allocated_by=requester, allocation_type="demo_unit",
                    request_id=request_id, remarks=remarks)
                alloc.add(collection_name=ALLOCATION_COLLECTION)
                ids.append(alloc.allocation_id)
    except Exception:
        # all-or-nothing: undo the allocations created so far and put the stock back,
        # otherwise the request stays pending with part of its stock already gone
        for aid in ids:
            try:
                mongodbclient().delete_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": aid})
            except Exception as del_err:
                logging.error(f"rollback: could not delete allocation {aid}: {del_err}")
        _rollback_stock(inventory_db, deducted)
        raise
    logging.info(f"demo request {request_id} allocated to {requester}: {ids}")
    return ids


@app.post("/allocation/assign_demo")
def assign_demo_unit(request: AssignDemoRequest, user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        tech = request.technician_id.strip()
        if not tech:
            raise HTTPException(status_code=400, detail="select a technician")
        ids = _fulfill_demo_request([i.dict() for i in request.items], tech, request.remarks.strip(), "")
        _notify([tech], kind="demo_assigned", title="Demo unit assigned to you",
                body=", ".join(f"{i.product_name} x{i.quantity}" for i in request.items),
                link="/pages/technician.html?tab=demo")
        return {"message": "demo unit assigned", "allocation_ids": ids}
    except HTTPException:
        raise
    except Exception:
        logging.error("demo unit assignment failed")
        raise HTTPException(status_code=500, detail="demo unit could not be assigned")


@app.post("/allocation/reassign_demo/{allocation_id}")
def reassign_demo_unit(allocation_id: str, request: ReassignDemoRequest,
                       user: dict = Depends(require_role("service_manager", "admin", "accounts"))):
    try:
        tech = request.technician_id.strip()
        if not tech:
            raise HTTPException(status_code=400, detail="select a technician")
        rows = mongodbclient().get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not rows or rows[0].get("allocation_type") not in ("demo_unit", "product"):
            raise HTTPException(status_code=404, detail="demo unit not found")
        if rows[0].get("return_status"):
            raise HTTPException(status_code=409, detail="this demo unit is already returned")
        mongodbclient().update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                                    update_values={"allocated_by": tech, "sales_person": _user_snapshot(tech)})
        _notify([tech], kind="demo_assigned", title="Demo unit assigned to you", body="A demo unit was handed over to you",
                link="/pages/technician.html?tab=demo")
        return {"message": "demo unit reassigned", "allocation_id": allocation_id}
    except HTTPException:
        raise
    except Exception:
        logging.error("demo unit reassignment failed")
        raise HTTPException(status_code=500, detail="demo unit could not be reassigned")


@app.post("/allocation/create_demo_unit")
def create_demo_unit_allocation(request: CreateDemoUnitRequest, user: dict = Depends(require_role("admin", "accounts"))):
    try:
        allocation_id = _fulfill_demo_unit(
            customer_id=request.customer_id,
            customer=request.customer,
            items=[item.dict() for item in request.items],
            allocated_by=user["username"]
        )
        return {"message": "demo unit allotted successfully", "allocation_id": allocation_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("demo unit allocation failed!")
        raise HTTPException(status_code=500, detail="demo unit allocation failed")


class DemoUnitRequestModel(BaseModel):
    items: list[AllocationItem]
    remarks: str = ""


class ServiceRequestModel(BaseModel):
    product_id: str
    company_name: str = ""
    product_name: str = ""
    model_no: str = ""
    serial_no: str
    purchase_date: str
    issue: str
    image: str = ""
    video: str = ""
    location: str = "indoor"
    spare_parts: str = ""
    address: str = ""


class SparePartRequestFlagModel(BaseModel):
    service_id: str
    note: str


class OrderRequestModel(BaseModel):
    customer_id: str = ""
    customer: dict = {}
    items: list[OrderItem]
    payment_mode: str
    payment_details: dict = {}
    discount: float = 0


class RequestRejectModel(BaseModel):
    reason: str = ""


class RequestApproveModel(BaseModel):
    # only used when approving a convert_to_order request
    invoice_no: str = ""
    invoice_date: str = ""
    payment_mode: str = ""          # same modes as a normal order (Credit / Partial / UPI ...)
    payment_details: dict = {}


class ReturnRequestModel(BaseModel):
    returned_through: str                 # courier / transport / person name etc.
    proof: dict = {}                      # optional: {"name": str, "type": str, "data": "<data URL>"}


class ConvertToOrderRequest(BaseModel):
    customer_id: str = ""          # set when an already-registered company is picked
    company_name: str = ""         # used only when no customer_id is given
    company_address: str = ""
    gst_number: str = ""
    price: float
    tax_rate: float = 0


@app.post("/request/demo_unit")
def raise_demo_unit_request(request: DemoUnitRequestModel, user: dict = Depends(require_role("distributor"))):
    try:
        if not request.items:
            raise HTTPException(status_code=400, detail="add at least one product")

        req = request_manager(
            request_type="demo_unit",
            raised_by=user["username"],
            details={
                "items": [item.dict() for item in request.items],
                "remarks": (request.remarks or "").strip()
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "request raised successfully, waiting for admin/accounts approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising demo unit request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


def _can_act_on_demo(alloc: dict, user: dict) -> bool:
    owner = alloc.get("allocated_by")
    if owner == user["username"]:
        return True
    try:
        team = mongodbclient().get_data(collection_name=ACCOUNTS_COLLECTION,
                                        query={"role": "distributor", "manager": user["username"]})
        return owner in {t.get("username") for t in team}
    except Exception:
        logging.error("team lookup failed while checking demo unit ownership")
        return False


@app.post("/allocation/convert_to_order/{allocation_id}")
def convert_demo_to_order(allocation_id: str, request: ConvertToOrderRequest, user: dict = Depends(require_role("distributor", "inventory_manager"))):
    """Distributor asks to turn a dispatched demo unit into an order. Raises an approval request."""
    try:
        if request.price <= 0:
            raise HTTPException(status_code=400, detail="enter a valid price")

        adb = allocation_manager()
        matches = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="demo unit not found")
        alloc = matches[0]
        # same allocation types the My Demo Units table lists (/allocation/mine)
        if alloc.get("allocation_type") not in ("demo_unit", "product") or not _can_act_on_demo(alloc, user):
            raise HTTPException(status_code=403, detail="this is not your demo unit")
        if not alloc.get("dispatch"):
            raise HTTPException(status_code=400, detail="only dispatched demo units can be converted to an order")
        if alloc.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this demo unit was already returned")
        if (alloc.get("convert_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="an order request is already pending for this demo unit")
        if (alloc.get("return_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="a return request is pending for this demo unit")

        if request.customer_id.strip():
            # an already-registered company was picked: reuse it (no duplicate gets created on approval)
            rows = customer_manager().get_data(collection_name=CUSTOMER_COLLECTION,
                                               query={"customer_id": request.customer_id.strip()})
            if not rows:
                raise HTTPException(status_code=404, detail="selected company not found")
            picked = rows[0]
            if picked.get("created_by") not in (user["username"], alloc.get("allocated_by")):
                raise HTTPException(status_code=403, detail="this company does not belong to you")
            customer = {
                "customer_id": picked["customer_id"],
                "company_name": picked.get("company_name", ""),
                "company_address": picked.get("company_address", ""),
                "gst_number": picked.get("gst_number", ""),
            }
        else:
            if not request.company_name.strip() or not request.company_address.strip():
                raise HTTPException(status_code=400, detail="company name and address are required")
            customer = {
                "company_name": request.company_name.strip(),
                "company_address": request.company_address.strip(),
                "gst_number": request.gst_number.strip(),
            }
        items = [{
            "product_id": i.get("product_id"), "product_name": i.get("product_name"),
            "model_no": i.get("model_no", ""), "serial_numbers": i.get("serial_numbers", []),
            "quantity": i.get("quantity", 1), "price": request.price, "tax_rate": request.tax_rate
        } for i in alloc.get("items", [])]

        req = request_manager(
            request_type="convert_to_order",
            raised_by=user["username"],
            details={"allocation_id": allocation_id, "customer": customer, "items": items,
                     "price": request.price, "tax_rate": request.tax_rate}
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        adb.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                        update_values={"convert_request": {"request_id": req.request_id, "status": "pending",
                                                           "price": request.price, "tax_rate": request.tax_rate,
                                                           "customer": customer}})
        return {"message": "order request sent for approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"convert to order request failed! {e}")
        raise HTTPException(status_code=500, detail="order request could not be raised")


@app.post("/allocation/return_request/{allocation_id}")
def raise_demo_return_request(allocation_id: str, request: ReturnRequestModel, user: dict = Depends(require_role("distributor", "inventory_manager"))):
    """Distributor reports a dispatched demo unit as returned; it is marked returned once approved."""
    try:
        through = request.returned_through.strip()
        if not through:
            raise HTTPException(status_code=400, detail="enter who/what the unit was returned through")

        proof = {}
        if request.proof and request.proof.get("data"):
            data = str(request.proof.get("data"))
            if len(data) > 2_500_000:          # ~1.8 MB file once base64-encoded
                raise HTTPException(status_code=400, detail="proof file is too large (max 1.5 MB)")
            if not data.startswith(("data:image/", "data:application/pdf")):
                raise HTTPException(status_code=400, detail="proof must be an image or a PDF")
            proof = {"name": str(request.proof.get("name", "proof"))[:120], "type": request.proof.get("type", ""), "data": data}

        adb = allocation_manager()
        matches = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="demo unit not found")
        alloc = matches[0]
        if alloc.get("allocation_type") != "demo_unit" or not _can_act_on_demo(alloc, user):
            raise HTTPException(status_code=403, detail="this is not your demo unit")
        if alloc.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this demo unit was already returned")
        if not alloc.get("dispatch"):
            raise HTTPException(status_code=400, detail="only dispatched demo units can be returned")
        if (alloc.get("return_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="a return request is already pending for this demo unit")
        if (alloc.get("convert_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="an order request is pending for this demo unit")

        req = request_manager(
            request_type="return_demo",
            raised_by=user["username"],
            details={"allocation_id": allocation_id, "returned_through": through,
                     "items": alloc.get("items", []), "proof": proof}
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        adb.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                        update_values={"return_request": {"request_id": req.request_id, "status": "pending",
                                                          "returned_through": through, "has_proof": bool(proof)}})
        return {"message": "return request sent for approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"return request failed! {e}")
        raise HTTPException(status_code=500, detail="return request could not be raised")


_REQ_LOCKS = {}
_REQ_LOCKS_GUARD = threading.Lock()


@contextlib.contextmanager
def _request_lock(request_id: str):
    with _REQ_LOCKS_GUARD:
        lock = _REQ_LOCKS.setdefault(request_id, threading.Lock())
    if not lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="this request is already being processed, please wait")
    try:
        yield
    finally:
        lock.release()
        with _REQ_LOCKS_GUARD:
            _REQ_LOCKS.pop(request_id, None)


def _convert_demo_to_order(alloc: dict, details: dict, raised_by: str, approver: str, invoice_no: str, invoice_date: str,
                           payment_mode: str = "", payment_details: dict = None, request_id: str = ""):
    """Moves an approved demo unit into Orders: same products/serials/company/price, dispatch info
    carried over (with the entered invoice details), and the allocation entry is removed.
    Stock is NOT touched — the units were already deducted when the demo was allotted.
    The order gets a real payment mode (Credit / Partial / UPI ...) chosen at conversion time."""
    already = (alloc.get("converted_to_order") or {}).get("order_id")
    if already:
        return already
    # validate the payment first so a bad choice never leaves a half-created company behind
    conv_items = [{"price": details.get("price", 0), "tax_rate": details.get("tax_rate", 0), "quantity": i.get("quantity", 1)}
                  for i in alloc.get("items", [])]
    payment_details = _validate_order_payment(payment_mode, payment_details, _order_grand_total(conv_items))

    cust = dict(details.get("customer") or {})
    existing = []
    if cust.get("customer_id"):
        # an already-registered company was picked: reuse it instead of creating a duplicate
        existing = customer_manager().get_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": cust["customer_id"]})
    if existing:
        customer_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
    else:
        new_customer = customer_manager(
            company_name=cust.get("company_name"),
            company_address=cust.get("company_address"),
            gst_number=cust.get("gst_number"),
            contractor_person="",
            contractor_number="",
            contractor_email="",
        )
        new_customer.add(collection_name=CUSTOMER_COLLECTION)
        customer_manager().update_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": new_customer.customer_id},
                                        update_values={"created_by": raised_by})
        customer_snapshot = {
            "customer_id": new_customer.customer_id,
            "company_name": new_customer.company_name,
            "company_address": new_customer.company_address,
            "gst_number": new_customer.gst_number,
            "contractor_person": "", "contractor_number": "", "contractor_email": "",
            "created_by": raised_by,
        }

    price = details.get("price", 0)
    tax_rate = details.get("tax_rate", 0)
    order_items = [{
        "product_id": i.get("product_id"), "product_name": i.get("product_name"),
        "model_no": i.get("model_no", ""), "serial_numbers": i.get("serial_numbers", []),
        "quantity": i.get("quantity", 1), "price": price, "tax_rate": tax_rate
    } for i in alloc.get("items", [])]

    order = order_manager(
        customer=customer_snapshot, items=order_items,
        payment_mode=payment_mode, payment_details=payment_details, discount=0,
        creator={"type": "request", "raised_by": raised_by, "approved_by": approver}
    )
    order.add(collection_name=ORDERS_COLLECTION)

    dispatch = dict(alloc.get("dispatch") or {})
    dispatch.update({
        "invoice_no": invoice_no, "invoice_date": invoice_date,
        "bill_to_address": {"company_name": customer_snapshot["company_name"], "address": customer_snapshot["company_address"]},
    })
    order.update(collection_name=ORDERS_COLLECTION, query={"order_id": order.order_id},
                 update_values={"status": "processing", "dispatch": dispatch,
                                "converted_from_demo": {"allocation_id": alloc.get("allocation_id"),
                                                        "allotment_date": alloc.get("allotment_date")}})
    now_iso = datetime.now(timezone.utc).isoformat()
    try:
        allocation_manager().update_data(
            collection_name=ALLOCATION_COLLECTION, query={"allocation_id": alloc.get("allocation_id")},
            update_values={"return_status": "returned", "returned_on": now_iso, "returned_by": approver,
                           "converted_to_order": {"order_id": order.order_id, "converted_on": now_iso,
                                                  "converted_by": approver, "invoice_no": invoice_no},
                           "convert_request": {"request_id": request_id or "", "status": "approved",
                                               "order_id": order.order_id}})
    except Exception as alloc_err:
        logging.error(f"order {order.order_id} created but allocation {alloc.get('allocation_id')} could not be marked returned: {alloc_err}")
    logging.info(f"demo allocation {alloc.get('allocation_id')} converted to order {order.order_id}")
    return order.order_id


# ---- order attachments (P.O., etc.) — files live on disk, metadata on the request/order ----
ORDER_ATTACH_DIR = os.path.join(BASE_DIR, "order_attachments")
ORDER_ATTACH_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".xlsx", ".xls", ".csv", ".doc", ".docx"}
ORDER_ATTACH_MAX_FILES = 5
ORDER_ATTACH_MAX_BYTES = 10 * 1024 * 1024


@app.post("/request/order/{request_id}/attachments")
async def upload_order_attachments(request_id: str, files: list[UploadFile] = File(...),
                                   user: dict = Depends(require_role("distributor"))):
    db = request_manager()
    found = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
    if not found or found[0].get("request_type") != "order" or found[0].get("raised_by") != user["username"]:
        raise HTTPException(status_code=404, detail="order request not found")
    req = found[0]
    if req.get("status") != "pending":
        raise HTTPException(status_code=400, detail="attachments can only be added while the request is pending")

    details = dict(req.get("details") or {})
    attachments = list(details.get("attachments") or [])
    if len(attachments) + len(files) > ORDER_ATTACH_MAX_FILES:
        raise HTTPException(status_code=400, detail=f"maximum {ORDER_ATTACH_MAX_FILES} files per order")

    folder = os.path.join(ORDER_ATTACH_DIR, request_id)
    os.makedirs(folder, exist_ok=True)
    for f in files:
        original = os.path.basename(f.filename or "file")
        ext = os.path.splitext(original)[1].lower()
        if ext not in ORDER_ATTACH_EXT:
            raise HTTPException(status_code=400, detail=f"{original}: file type not allowed")
        content = await f.read()
        if len(content) > ORDER_ATTACH_MAX_BYTES:
            raise HTTPException(status_code=400, detail=f"{original}: larger than 10 MB")
        stored = f"{uuid.uuid4().hex}{ext}"
        with open(os.path.join(folder, stored), "wb") as out:
            out.write(content)
        attachments.append({"name": original, "stored_name": stored, "size": len(content),
                            "uploaded_at": datetime.now(timezone.utc).isoformat()})

    details["attachments"] = attachments
    db.update_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id},
                   update_values={"details": details})
    return {"message": "files attached", "attachments": attachments}


@app.get("/order_attachment/{request_id}/{stored_name}")
def download_order_attachment(request_id: str, stored_name: str, user: dict = Depends(get_current_user)):
    found = request_manager().get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
    if not found:
        raise HTTPException(status_code=404, detail="not found")
    req = found[0]
    if user.get("role") == "distributor" and req.get("raised_by") != user.get("username"):
        raise HTTPException(status_code=403, detail="not allowed")
    if user.get("role") not in ("distributor", "admin", "accounts"):
        raise HTTPException(status_code=403, detail="not allowed")
    meta = next((a for a in (req.get("details") or {}).get("attachments", []) if a.get("stored_name") == stored_name), None)
    path = os.path.join(ORDER_ATTACH_DIR, request_id, os.path.basename(stored_name))
    if not meta or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(path, filename=meta["name"])


@app.post("/request/order")
def raise_order_request(request: OrderRequestModel, user: dict = Depends(require_role("distributor"))):
    try:
        if not request.items:
            raise HTTPException(status_code=400, detail="add at least one product")
        if not request.customer_id and not request.customer.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")
        if request.payment_mode not in VALID_PAYMENT_MODES:
            raise HTTPException(status_code=400, detail="invalid payment mode")

        req = request_manager(
            request_type="order",
            raised_by=user["username"],
            details={
                "customer_id": request.customer_id,
                "customer": request.customer,
                "items": [item.dict() for item in request.items],
                "payment_mode": request.payment_mode,
                "payment_details": request.payment_details,
                "discount": request.discount
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "request sent, waiting for admin/accounts approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising order request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.post("/request/service")
def raise_service_request(request: ServiceRequestModel, user: dict = Depends(require_role("technician", "distributor"))):
    try:
        address = _check_field_address(request.location, request.address)
        req = request_manager(
            request_type="service",
            raised_by=user["username"],
            details={
                "product_id": request.product_id,
                "company_name": request.company_name,
                "product_name": request.product_name,
                "model_no": request.model_no,
                "serial_no": request.serial_no,
                "purchase_date": request.purchase_date,
                "issue": request.issue,
                "image": request.image,
                "video": request.video,
                "location": request.location,
                "spare_parts": request.spare_parts,
                "address": address
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "service request sent, waiting for admin/accounts approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising service request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.get("/request/")
def all_requests(user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = request_manager()
        # return-proof files are base64 blobs — fetched on demand via /request/{id}/proof
        dataset = db.get_data(collection_name=REQUESTS_COLLECTION, query={}, projection={"details.proof.data": 0})
        return {"message": "requests", "dataset": dataset}
    except Exception as e:
        logging.error("fetching requests failed")
        raise HTTPException(status_code=500, detail="requests cannot be fetched")


@app.get("/request/{request_id}/proof")
def request_proof(request_id: str, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        docs = request_manager().get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id},
                                          projection={"details.proof": 1})
        proof = ((docs[0].get("details") or {}).get("proof")) if docs else None
        return {"proof": proof or {}}
    except Exception:
        logging.error("fetching request proof failed")
        raise HTTPException(status_code=500, detail="proof cannot be fetched")


@app.get("/request/mine")
def my_requests(user: dict = Depends(get_current_user)):
    try:
        db = request_manager()
        dataset = db.get_data(collection_name=REQUESTS_COLLECTION, query={"raised_by": user["username"]},
                              projection={"details.proof.data": 0})
        return {"message": "my requests", "dataset": dataset}
    except Exception as e:
        logging.error("fetching my requests failed")
        raise HTTPException(status_code=500, detail="requests cannot be fetched")


@app.post("/request/approve/{request_id}")
def approve_request(request_id: str, body: RequestApproveModel = None, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    with _request_lock(request_id):
        return _approve_request_locked(request_id, body, user)


def _approve_request_locked(request_id: str, body, user: dict):
    try:
        db = request_manager()
        existing = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
        if not existing:
            raise HTTPException(status_code=404, detail="request not found")
        req = existing[0]
        if req["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"request already {req['status']}")

        if req["request_type"] == "demo_unit":
            details = req["details"]
            if details.get("customer") or details.get("customer_id"):   # legacy requests raised with customer details
                allocation_id = _fulfill_demo_unit(
                    customer_id=details.get("customer_id", ""),
                    customer=details.get("customer", {}),
                    items=details.get("items", []),
                    allocated_by=req["raised_by"]
                )
                ids = [allocation_id]
            else:
                ids = _fulfill_demo_request(
                    items=details.get("items", []), requester=req["raised_by"],
                    remarks=details.get("remarks", ""), request_id=request_id)
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and demo unit allotted", "allocation_ids": ids}

        if req["request_type"] == "return_demo":
            details = req["details"]
            aid = details.get("allocation_id")
            # same logic as a manual return: marks returned + puts the unit back into stock
            return_allocation(aid, user)
            allocation_manager().update_data(
                collection_name=ALLOCATION_COLLECTION, query={"allocation_id": aid},
                update_values={"return_request": {"request_id": request_id, "status": "approved",
                                                  "returned_through": details.get("returned_through", ""),
                                                  "has_proof": bool(details.get("proof"))}})
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "return approved and demo unit marked as returned"}

        if req["request_type"] == "convert_to_order":
            if not body or not body.invoice_no.strip() or not body.invoice_date.strip():
                raise HTTPException(status_code=400, detail="invoice number and invoice date are required")
            details = req["details"]
            found = allocation_manager().get_data(collection_name=ALLOCATION_COLLECTION,
                                                  query={"allocation_id": details.get("allocation_id")})
            if not found:
                raise HTTPException(status_code=404, detail="demo unit allocation no longer exists")
            order_id = _convert_demo_to_order(found[0], details, req["raised_by"], user["username"],
                                              body.invoice_no.strip(), body.invoice_date.strip(),
                                              body.payment_mode, body.payment_details, request_id=request_id)
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and demo unit converted to order", "order_id": order_id}

        if req["request_type"] == "order":
            details = req["details"]
            order_id = _fulfill_order(
                customer_id=details.get("customer_id", ""),
                customer=details.get("customer", {}),
                items=details.get("items", []),
                payment_mode=details.get("payment_mode"),
                payment_details=details.get("payment_details", {}),
                discount=details.get("discount", 0),
                creator={"type": "request", "raised_by": req["raised_by"], "approved_by": user["username"]}
            )
            # carry the P.O./attachments over to the order (files stay under the request id)
            if details.get("attachments"):
                order_manager().update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id},
                                       update_values={"attachments": [dict(a, request_id=request_id) for a in details["attachments"]]})
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and order created", "order_id": order_id}

        # service: technician/distributor asked for a new service ticket to be
        # opened — approving creates the real service record and assigns it
        # back to whoever raised the request.
        if req["request_type"] == "service":
            details = req["details"]
            service = service_detail(product_id=details.get("product_id"), serial_no=details.get("serial_no"))
            service.add_service(
                collection_name=SERVICE_COLLECTION,
                purchase_date=details.get("purchase_date"),
                issue=details.get("issue"),
                image=details.get("image", ""),
                video=details.get("video", ""),
                technician_id=req["raised_by"],
                location=details.get("location", "indoor"),
                spare_parts=details.get("spare_parts", ""),
                created_by=req["raised_by"],
                product_name=details.get("product_name", ""),
                model_no=details.get("model_no", ""),
                company_name=details.get("company_name", "")
            )
            _save_service_address(service.service_id, details.get("address", ""))
            if details.get("video"):
                _raise_media_review_request(service.service_id, user["username"])
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and service created", "service_id": service.service_id}

        if req["request_type"] == "reschedule":
            details = req["details"]
            _apply_reschedule_request(details, req["raised_by"])
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            _notify([req["raised_by"]], kind="reschedule_approved", title="Reschedule approved",
                    body=f"{details.get('label')} is now on {details.get('requested_date')}",
                    service_id=details.get("target_id", ""), link="/pages/technician.html?tab=requests")
            return {"message": "reschedule approved"}

        # media_review: approving means admin/accounts confirmed they downloaded the
        # video — it's cleared from the database afterwards to free up storage.
        if req["request_type"] == "media_review":
            service_id = req["details"].get("service_id")
            if service_id:
                svc_db = service_detail()
                svc_db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id},
                                    update_values={"video": ""})
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "video download confirmed and removed from the database"}

        # status_update: technician-raised status change, applied only on admin/accounts approval
        if req["request_type"] == "status_update":
            details = req["details"]
            svc_db = service_detail(product_id="", serial_no="")
            svc_db.update_service_status(
                service_status=details.get("service_status"),
                reason=details.get("reason", ""),
                collection_name=SERVICE_COLLECTION,
                query={"service_id": details.get("service_id")},
                image=None,
                video=None,
                spare_parts_used=details.get("spare_parts_used", False),
                spare_parts=details.get("spare_parts", ""),
                service_charges=details.get("service_charges")
            )
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and service status updated", "service_id": details.get("service_id")}

        # spare_part requests: the service manager picks the hologram number(s) on the Allocated
        # page, which opens with this service and the requested part(s) already added. The request
        # stays pending until that allocation is made (create_allocation closes it).
        if req["request_type"] == "spare_part":
            details = req["details"] or {}
            parts = details.get("parts") or []
            names = [p.get("part_name", "") for p in parts if p.get("part_name")] or ([details.get("note")] if details.get("note") else [])
            qs = urllib.parse.urlencode({"alloc_service": details.get("service_id", ""),
                                         "alloc_parts": "|".join(names), "alloc_request": request_id})
            return {"message": "choose the hologram number(s) to allocate", "pending_allocation": True,
                    "service_id": details.get("service_id"), "parts": names,
                    "redirect": f"allocated.html?{qs}"}

        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                       status="approved", resolved_by=user["username"])
        return {"message": "request approved"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"approving request failed! {e}")
        raise HTTPException(status_code=500, detail=f"request could not be approved: {e}")


@app.post("/request/reject/{request_id}")
def reject_request(request_id: str, request: RequestRejectModel, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    with _request_lock(request_id):
        return _reject_request_locked(request_id, request, user)


def _reject_request_locked(request_id: str, request, user: dict):
    try:
        db = request_manager()
        existing = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
        if not existing:
            raise HTTPException(status_code=404, detail="request not found")
        if existing[0]["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"request already {existing[0]['status']}")

        if existing[0]["request_type"] == "media_review":
            service_id = existing[0]["details"].get("service_id")
            if service_id:
                svc_db = service_detail()
                svc_db.update_data(collection_name=SERVICE_COLLECTION, query={"service_id": service_id},
                                    update_values={"video": ""})

        if existing[0]["request_type"] == "reschedule":
            d = existing[0]["details"]
            _notify([existing[0]["raised_by"]], kind="reschedule_rejected", title="Reschedule request rejected",
                    body=f"{d.get('label')}" + (f" - {request.reason.strip()}" if request.reason.strip() else ""),
                    service_id=d.get("target_id", ""), link="/pages/technician.html?tab=requests")

        if existing[0]["request_type"] in ("convert_to_order", "return_demo"):
            aid = existing[0]["details"].get("allocation_id")
            field = "convert_request" if existing[0]["request_type"] == "convert_to_order" else "return_request"
            if aid:
                allocation_manager().update_data(
                    collection_name=ALLOCATION_COLLECTION, query={"allocation_id": aid},
                    update_values={field: {"request_id": request_id, "status": "rejected", "reason": request.reason}})

        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                       status="rejected", resolved_by=user["username"], reason=request.reason)
        return {"message": "request rejected"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("rejecting request failed!")
        raise HTTPException(status_code=500, detail="request could not be rejected")


class PartialApproveModel(BaseModel):
    approved_indexes: list[int]
    remarks: str


class PartialRespondModel(BaseModel):
    accept: bool
    reason: str = ""


@app.post("/request/partial_approve/{request_id}")
def partial_approve_request(request_id: str, body: PartialApproveModel, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        db = request_manager()
        found = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
        if not found:
            raise HTTPException(status_code=404, detail="request not found")
        req = found[0]
        if req["status"] != "pending":
            raise HTTPException(status_code=400, detail=f"request already {req['status']}")
        if req["request_type"] not in ("demo_unit", "order"):
            raise HTTPException(status_code=400, detail="partial approval is only for demo unit and order requests")
        details = dict(req.get("details") or {})
        items = list(details.get("items") or [])
        if len(items) < 2:
            raise HTTPException(status_code=400, detail="partial approval needs at least 2 products")
        idx = sorted(set(body.approved_indexes))
        if not idx or any(i < 0 or i >= len(items) for i in idx):
            raise HTTPException(status_code=400, detail="select at least one product to approve")
        if len(idx) >= len(items):
            raise HTTPException(status_code=400, detail="all products selected, use normal approve")
        remarks = (body.remarks or "").strip()
        if not remarks:
            raise HTTPException(status_code=400, detail="remarks are required for partial approval")
        now = datetime.now(timezone.utc).isoformat()
        details["partial"] = {
            "approved_items": [items[i] for i in idx],
            "unapproved_items": [items[i] for i in range(len(items)) if i not in idx],
            "remarks": remarks,
            "by": user["username"],
            "at": now
        }
        db.update_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id},
                       update_values={"status": "partially_approved", "details": details,
                                      "resolved_by": user["username"], "resolved_at": now, "reason": remarks})
        return {"message": "partially approved, sent back to the distributor for confirmation"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"partial approval failed! {e}")
        raise HTTPException(status_code=500, detail="partial approval failed")


@app.post("/request/partial_respond/{request_id}")
def partial_respond_request(request_id: str, body: PartialRespondModel, user: dict = Depends(require_role("distributor"))):
    try:
        import shutil
        db = request_manager()
        found = db.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": request_id})
        if not found or found[0].get("raised_by") != user["username"]:
            raise HTTPException(status_code=404, detail="request not found")
        req = found[0]
        if req["status"] != "partially_approved":
            raise HTTPException(status_code=400, detail=f"request already {req['status']}")
        partial = (req.get("details") or {}).get("partial") or {}

        if not body.accept:
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                          status="partial_rejected", resolved_by=user["username"], reason=(body.reason or "").strip())
            return {"message": "partial approval rejected, request closed"}

        new_details = {k: v for k, v in (req.get("details") or {}).items() if k != "partial"}
        new_details["items"] = partial.get("approved_items", [])
        new_details["parent_request_id"] = request_id
        new_req = request_manager(request_type=req["request_type"], raised_by=req["raised_by"], details=new_details)
        src = os.path.join(ORDER_ATTACH_DIR, request_id)
        if new_details.get("attachments") and os.path.isdir(src):
            shutil.copytree(src, os.path.join(ORDER_ATTACH_DIR, new_req.request_id), dirs_exist_ok=True)
        new_req.add(collection_name=REQUESTS_COLLECTION)
        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                      status="partial_accepted", resolved_by=user["username"], reason=(body.reason or "").strip())
        return {"message": "accepted, new request raised for approved products", "request_id": new_req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"partial response failed! {e}")
        raise HTTPException(status_code=500, detail="could not submit response")


@app.post("/allocation/create")
def create_allocation(request: CreateAllocationRequest, user: dict = Depends(require_role("admin", "accounts", "service_manager"))):
    try:
        if not request.items and not request.spare_part:
            raise HTTPException(status_code=400, detail="add at least one product or a spare part")

        sales_person_snapshot = {}
        if request.items:
            if not request.allocated_to:
                raise HTTPException(status_code=400, detail="select a system user to allocate to")
            sales_person_snapshot = _user_snapshot(request.allocated_to)

        inventory_db = inventory_manager()
        # keyed by (product_id, model_no): two variants sharing the same
        # product_id (e.g. black vs grey) must be checked/allocated against
        # their own lot, not each other's stock — same fix as order fulfillment
        for item in request.items:
            available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item.product_id, model_no=item.model_no or None,
                                                             product_name=item.product_name or None, product_type=item.product_type or None)
            if available < item.quantity:
                variant_note = f" (model {item.model_no})" if item.model_no else ""
                raise HTTPException(status_code=400, detail=f"insufficient stock for {item.product_name}{variant_note}: only {available} available")

        # No more partial returns: every allocated unit becomes its own
        # allocation document (quantity=1, one serial number each) instead of
        # bundling the whole quantity into a single row. A cart of ProductA x2
        # therefore creates two separate rows on the Allocated page, each
        # independently returnable.
        #
        # allocate_serials() (strict) requires every unit to already have a
        # serial number on file — but accessories/spare_parts are legitimately
        # allowed to be stocked with NO serial numbers at all (see
        # /inventory/create), even though get_available_quantity() above
        # correctly counts their quantity as available. That mismatch meant
        # allocating any such product here failed with "insufficient stock"
        # right after the precheck said stock WAS available — allocation
        # would never go through. allocate_units() is the tolerant version
        # used everywhere else in this file (order fulfillment, order edits):
        # it decrements quantity regardless of serial coverage and returns
        # whatever serials it did find, which may be fewer than requested
        # (or none). We still create one allocation row per unit as before —
        # rows for units with no serial on file just carry an empty
        # serial_numbers list instead of failing the whole allocation.
        created_allocation_ids = []
        for item in request.items:
            if item.serial_numbers:
                allocated_serials = inventory_db.allocate_specific_serials(
                    collection_name=INVENTORY_COLLECTION,
                    product_id=item.product_id,
                    serial_numbers=item.serial_numbers,
                    model_no=item.model_no or None,
                    product_name=item.product_name or None,
                    product_type=item.product_type or None
                )
            else:
                allocated_serials = _auto_pick_item(inventory_db, item.dict())
            for i in range(item.quantity):
                serial = allocated_serials[i] if i < len(allocated_serials) else None
                unit_allocation = allocation_manager(
                    sales_person=sales_person_snapshot,
                    allocated_by=request.allocated_to,
                    created_by=user["username"],
                    items=[{
                        "product_id": item.product_id,
                        "product_name": item.product_name,
                        "model_no": item.model_no,
                        "quantity": 1,
                        "serial_numbers": [serial] if serial else []
                    }],
                    company_name=request.company_name,
                    address=request.address,
                    gst_number=request.gst_number,
                    phone_number=request.phone_number
                )
                unit_allocation.add(collection_name=ALLOCATION_COLLECTION)
                created_allocation_ids.append(unit_allocation.allocation_id)

        spare_part_dict = None
        redirect_to = None
        if request.spare_part:
            svc_db = service_detail()
            existing_service = svc_db.get_service_data(SERVICE_COLLECTION, query={"service_id": request.spare_part.service_id})
            if not existing_service:
                raise HTTPException(status_code=404, detail="selected service not found")

            # take the chosen item out of inventory (only when the caller said which one)
            sp = request.spare_part
            holograms = [h.strip() for h in sp.hologram_numbers if h and h.strip()]
            try:
                if holograms:
                    if len(set(holograms)) != len(holograms):
                        raise HTTPException(status_code=400, detail="duplicate hologram numbers selected")
                    inventory_db.allocate_specific_holograms(INVENTORY_COLLECTION, holograms, product_name=sp.part_name)
                    sp.quantity = len(holograms)
                elif sp.lot_id:
                    if sp.quantity <= 0:
                        raise HTTPException(status_code=400, detail="quantity must be greater than 0")
                    inventory_db.consume_from_lot(INVENTORY_COLLECTION, sp.lot_id, sp.quantity, product_name=sp.part_name)
            except HTTPException:
                raise
            except Exception as inv_err:
                raise HTTPException(status_code=400, detail=str(inv_err))

            svc_db.update_data(
                collection_name=SERVICE_COLLECTION,
                query={"service_id": request.spare_part.service_id},
                update_values={"spare_parts_requested": request.spare_part.part_name}
            )
            spare_part_dict = request.spare_part.dict()
            redirect_to = "service.html"

            spare_allocation = allocation_manager(
                created_by=user["username"],
                spare_part=spare_part_dict,
                company_name=request.company_name,
                address=request.address,
                gst_number=request.gst_number,
                phone_number=request.phone_number
            )
            spare_allocation.add(collection_name=ALLOCATION_COLLECTION)
            created_allocation_ids.append(spare_allocation.allocation_id)

            # fulfilling a technician's spare part request: close it once every requested part is issued
            rid = (request.spare_part.request_id or "").strip()
            if rid:
                try:
                    rdb = request_manager()
                    found = rdb.get_data(collection_name=REQUESTS_COLLECTION, query={"request_id": rid})
                    if found and found[0].get("request_type") == "spare_part" and found[0].get("status") == "pending":
                        d = found[0].get("details") or {}
                        wanted = len(d.get("parts") or []) or 1
                        done = len(allocation_manager().get_data(
                            collection_name=ALLOCATION_COLLECTION,
                            query={"allocation_type": "spare_part", "spare_part.request_id": rid}))
                        if done >= wanted:
                            rdb.set_status(collection_name=REQUESTS_COLLECTION, request_id=rid,
                                           status="approved", resolved_by=user["username"])
                            _notify([found[0]["raised_by"]], kind="spare_part_allocated",
                                    title="Spare part allocated",
                                    body="Your requested spare part was allocated to you.",
                                    service_id=request.spare_part.service_id, link="/pages/technician.html?tab=parts")
                except Exception as close_err:
                    logging.error(f"could not close spare part request {rid}: {close_err}")

        logging.info(f"allocation(s) created successfully: {created_allocation_ids}")
        return {"message": "allocation created successfully", "allocation_ids": created_allocation_ids, "redirect": redirect_to}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("allocation creation failed!")
        raise HTTPException(status_code=500, detail="allocation creation failed")


def _normalize_return_item(item):
    """Tolerant view of an allocation item (MCP / older records may miss quantity, model_no etc.)."""
    serials = [str(x).strip() for x in (item.get("serial_numbers") or []) if x and str(x).strip()]
    try:
        qty = int(item.get("quantity") or 0)
    except (TypeError, ValueError):
        qty = 0
    if qty <= 0:
        qty = len(serials) or 1
    pid = str(item.get("product_id") or "").strip()
    name = str(item.get("product_name") or "").strip() or pid or "Returned item"
    model = str(item.get("model_no") or item.get("model_number") or "").strip()
    return {"product_id": pid, "product_name": name, "model_no": model, "quantity": qty, "serial_numbers": serials}


def _restock_one_item(inv_db, it):
    """Same product_id + name + model -> merged into that lot, else a new lot is created. Never gives up silently."""
    last_err = None
    for _ in range(2):  
        try:
            inv_db.restock_returned_units(
                collection_name=INVENTORY_COLLECTION,
                product_id=it["product_id"],
                product_name=it["product_name"],
                model_no=it["model_no"],
                quantity=it["quantity"],
                serial_numbers=it["serial_numbers"],
            )
            return "restocked"
        except Exception as e:
            last_err = e
            logging.error(f"restock attempt failed for {it['product_name']}: {e}")
    # last resort: force a fresh inventory entry so the returned stock is never lost
    inventory_manager(
        product_name=it["product_name"],
        product_id=it["product_id"] or f"RET-{uuid.uuid4().hex[:8].upper()}",
        model_no=it["model_no"],
        quantity=it["quantity"],
        purchase_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        lot_no="", supplier="", price="", tax_rate=0,
        serial_numbers=it["serial_numbers"],
        product_type="product",
    ).add(collection_name=INVENTORY_COLLECTION)
    logging.warning(f"restock fell back to a fresh entry for {it['product_name']} (reason: {last_err})")
    return "created_fallback"


@app.post("/allocation/return/{allocation_id}")
def return_allocation(allocation_id: str, user: dict = Depends(require_role("admin", "accounts", "distributor", "service_manager"))):
    """
    Inventory is updated FIRST, the allocation is marked returned only after that
    succeeds. So a return can never end up "returned but not in inventory" — if
    anything fails the allocation stays pending and the request can simply be
    retried (per-item progress is saved, so nothing is added twice).
    """
    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        allocation = matches[0]

        if allocation.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this allocation is already returned")

        damage_report = allocation.get("damage_report") or {}
        is_damaged = bool(damage_report.get("reported"))
        is_spare = allocation.get("allocation_type") == "spare_part"
        done = set(allocation.get("restocked_item_idx") or [])
        inv_db = inventory_manager()
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        if is_spare:
            # spare parts were consumed by the service; only a damaged return goes back (as damaged stock)
            
            sp = allocation.get("spare_part", {}) or {}
            part_name = sp.get("part_name", "")
            qty = sp.get("quantity", 0) or 0
            if is_damaged and part_name and qty > 0 and 0 not in done:
                reason = f"returned damaged from allocation {allocation_id}"
                if damage_report.get("issue"):
                    reason += f" — {damage_report['issue']}"
                inventory_manager(
                    product_name=part_name, product_id=f"DMG-{uuid.uuid4().hex[:8].upper()}",
                    quantity=qty, purchase_date=today, product_type="damaged", reason=reason,
                ).add(collection_name=INVENTORY_COLLECTION)
        else:
            for idx, raw in enumerate(allocation.get("items", []) or []):
                if idx in done:
                    continue
                it = _normalize_return_item(raw)
                if is_damaged:
                    reason = f"returned damaged from allocation {allocation_id}"
                    if damage_report.get("issue"):
                        reason += f" — {damage_report['issue']}"
                    if it["product_id"]:
                        reason += f" (original product_id: {it['product_id']})"
                    inventory_manager(
                        product_name=it["product_name"], product_id=f"DMG-{uuid.uuid4().hex[:8].upper()}",
                        quantity=it["quantity"], purchase_date=today,
                        serial_numbers=it["serial_numbers"], product_type="damaged", reason=reason,
                    ).add(collection_name=INVENTORY_COLLECTION)
                else:
                    _restock_one_item(inv_db, it)
                done.add(idx)
                # save progress so a retry never double-adds items that already went in
                db.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id},
                               update_values={"restocked_item_idx": sorted(done)})

        db.update_data(
            collection_name=ALLOCATION_COLLECTION,
            query={"allocation_id": allocation_id},
            update_values={
                "return_status": "returned",
                "return_completed_at": datetime.now(timezone.utc).isoformat(),
                "returned_by": user["username"],
                "restocked": True,
            }
        )
        logging.info(f"allocation {allocation_id} returned and inventory updated")
        return {"message": "allocation marked as returned", "allocation_id": allocation_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"marking allocation as returned failed! {e}")
        raise HTTPException(status_code=500, detail="return failed while updating inventory — nothing was lost, please retry")


class EditAllocationRequest(BaseModel):
    serial_numbers: Optional[List[str]] = None
    company_name: Optional[str] = None
    address: Optional[str] = None
    gst_number: Optional[str] = None
    phone_number: Optional[str] = None
    remarks: Optional[str] = None


@app.post("/allocation/edit/{allocation_id}")
def edit_allocation(allocation_id: str, request: EditAllocationRequest, user: dict = Depends(require_role("admin", "accounts"))):
    """
    Edit an allocation. Changing a serial number swaps stock: the new serial is deducted
    from inventory, the old (auto-picked) serial goes back into inventory.
    """
    try:
        db = allocation_manager()
        found = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not found:
            raise HTTPException(status_code=404, detail="allocation not found")
        alloc = found[0]
        if alloc.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="a returned allocation cannot be edited")
        if alloc.get("dispatch"):
            raise HTTPException(status_code=400, detail="a dispatched allocation cannot be edited")

        updates = {}
        for f in ("company_name", "address", "gst_number", "phone_number", "remarks"):
            v = getattr(request, f)
            if v is not None:
                updates[f] = v.strip()

        history_entry = {"edited_by": user["username"], "edited_at": datetime.now(timezone.utc).isoformat()}

        if request.serial_numbers is not None:
            items = list(alloc.get("items") or [])
            if alloc.get("allocation_type") == "spare_part" or len(items) != 1:
                raise HTTPException(status_code=400, detail="serial numbers can only be edited on a single-product allocation")
            it = _normalize_return_item(items[0])
            new = list(dict.fromkeys(x.strip() for x in request.serial_numbers if x and x.strip()))
            old = it["serial_numbers"]
            if len(new) != it["quantity"]:
                raise HTTPException(status_code=400, detail=f"select exactly {it['quantity']} serial number(s)")

            removed = [x for x in old if x not in new]
            added = [x for x in new if x not in old]
            if added:
                inv_db = inventory_manager()
                model = it["model_no"] or None
                available = set(inv_db.list_available_serials(INVENTORY_COLLECTION, it["product_id"], model_no=model,
                                                         product_name=(items[0].get("product_name") or None)))
                missing = [x for x in added if x not in available]
                if missing:
                    raise HTTPException(status_code=400, detail=f"serial number(s) not available in inventory: {', '.join(missing)}")

                # 1) take the new serial(s) out of inventory
                inv_db.allocate_specific_serials(INVENTORY_COLLECTION, it["product_id"], added, model_no=model,
                                                 product_name=(items[0].get("product_name") or None))
                try:
                    # 2) put the old serial(s) back (units that never had a serial go back by quantity)
                    if removed:
                        _restock_one_item(inv_db, {**it, "quantity": len(removed), "serial_numbers": removed})
                    extra = len(added) - len(removed)
                    if extra > 0:
                        _restock_one_item(inv_db, {**it, "quantity": extra, "serial_numbers": []})
                except Exception:
                    # could not give the old stock back -> undo the new reservation so nothing is lost
                    _restock_one_item(inv_db, {**it, "quantity": len(added), "serial_numbers": added})
                    raise

            items[0] = {**items[0], "serial_numbers": new}
            updates["items"] = items
            history_entry.update({"old_serials": old, "new_serials": new})

        if not updates:
            raise HTTPException(status_code=400, detail="nothing to update")

        updates.update({"last_edited_by": user["username"], "last_edited_at": history_entry["edited_at"],
                        "edit_history": list(alloc.get("edit_history") or []) + [history_entry]})
        db.update_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id}, update_values=updates)
        return {"message": "allocation updated" + (" — old serial returned to inventory" if history_entry.get("old_serials") != history_entry.get("new_serials") and "new_serials" in history_entry else ""),
                "allocation_id": allocation_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"editing allocation failed! {e}")
        raise HTTPException(status_code=500, detail="allocation could not be updated")


class AdminConvertRequest(BaseModel):
    customer_id: str = ""          # set when an existing company was picked (no new company is created)
    company_name: str = ""
    company_address: str = ""
    gst_number: str = ""
    price: float
    tax_rate: float = 0
    invoice_no: str
    invoice_date: str
    payment_mode: str = ""
    payment_details: dict = {}


@app.post("/allocation/convert_to_order_direct/{allocation_id}")
def convert_demo_to_order_direct(allocation_id: str, request: AdminConvertRequest, user: dict = Depends(require_role("admin", "accounts"))):
    """Admin/accounts converts a dispatched demo unit straight into an order (no approval step)."""
    try:
        picked = None
        if request.customer_id.strip():
            rows = customer_manager().get_data(collection_name=CUSTOMER_COLLECTION, query={"customer_id": request.customer_id.strip()})
            if not rows:
                raise HTTPException(status_code=404, detail="selected company not found")
            picked = rows[0]
        elif not request.company_name.strip() or not request.company_address.strip():
            raise HTTPException(status_code=400, detail="company name and address are required")
        if request.price <= 0:
            raise HTTPException(status_code=400, detail="enter a valid price")
        if not request.invoice_no.strip() or not request.invoice_date.strip():
            raise HTTPException(status_code=400, detail="invoice number and invoice date are required")

        adb = allocation_manager()
        matches = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="demo unit not found")
        alloc = matches[0]
        if alloc.get("allocation_type") == "spare_part" or not alloc.get("items"):
            raise HTTPException(status_code=400, detail="spare part allocations cannot be converted to an order")
        if alloc.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this allocation was already returned")
        if (alloc.get("convert_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="an order request is already pending — approve it from Pending Requests")
        if (alloc.get("return_request") or {}).get("status") == "pending":
            raise HTTPException(status_code=400, detail="a return request is pending for this demo unit")

        if picked:
            customer = {"customer_id": picked["customer_id"], "company_name": picked.get("company_name", ""),
                        "company_address": picked.get("company_address", ""), "gst_number": picked.get("gst_number", "")}
        else:
            customer = {"company_name": request.company_name.strip(), "company_address": request.company_address.strip(),
                        "gst_number": request.gst_number.strip()}
        details = {"customer": customer, "price": request.price, "tax_rate": request.tax_rate}
        order_id = _convert_demo_to_order(alloc, details, alloc.get("allocated_by") or user["username"], user["username"],
                                          request.invoice_no.strip(), request.invoice_date.strip(),
                                          request.payment_mode, request.payment_details)
        return {"message": "demo unit converted to order", "order_id": order_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"direct convert to order failed! {e}")
        raise HTTPException(status_code=500, detail="demo unit could not be converted to an order")


MESSAGES_COLLECTION = params.get("messages_collection_name", "messages")


class SendMessageRequest(BaseModel):
    recipients: List[str]
    body: str


@app.get("/message/recipients")
def message_recipients(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        users = [
            {"username": a.get("username"), "name": a.get("name") or a.get("username"), "role": a.get("role")}
            for a in dataset if a.get("username") and a.get("username") != user["username"]
        ]
        return {"message": "message recipients", "dataset": users}
    except Exception:
        logging.error("message recipients cannot be fetched")
        raise HTTPException(status_code=500, detail="users cannot be fetched")


@app.post("/message/send")
def send_message(request: SendMessageRequest, user: dict = Depends(get_current_user)):
    body = (request.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="message cannot be empty")
    if len(body) > 2000:
        raise HTTPException(status_code=400, detail="message is too long (max 2000 characters)")
    recipients = list(dict.fromkeys(r for r in request.recipients if r and r != user["username"]))
    if not recipients:
        raise HTTPException(status_code=400, detail="select at least one recipient")
    try:
        db = mongodbclient()
        accounts = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": {"$in": recipients + [user["username"]]}})
        valid = {a.get("username") for a in accounts}
        targets = [r for r in recipients if r in valid]
        if not targets:
            raise HTTPException(status_code=404, detail="no valid recipients found")
        sender = next((a for a in accounts if a.get("username") == user["username"]), {})
        sender_name = sender.get("name") or user["username"]
        batch_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        for target in targets:
            db.add(collection_name=MESSAGES_COLLECTION, dictionary={
                "message_id": uuid.uuid4().hex,
                "batch_id": batch_id,
                "from_username": user["username"],
                "from_name": sender_name,
                "from_role": user["role"],
                "to_username": target,
                "body": body,
                "read": False,
                "delivered": False,
                "created_at": now,
            })
        logging.info(f"message sent by {user['username']} to {len(targets)} recipient(s)")
        return {"message": "message sent", "sent": len(targets)}
    except HTTPException:
        raise
    except Exception:
        logging.error("message could not be sent")
        raise HTTPException(status_code=500, detail="message could not be sent")


@app.get("/message/inbox")
def message_inbox(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=MESSAGES_COLLECTION, query={"to_username": user["username"]}, projection={"_id": 0})
        dataset = sorted(dataset, key=lambda m: m.get("created_at") or "", reverse=True)[:100]
        return {"message": "inbox", "dataset": dataset}
    except Exception:
        logging.error("inbox cannot be fetched")
        raise HTTPException(status_code=500, detail="inbox cannot be fetched")


@app.get("/message/all")
def message_all(user: dict = Depends(require_role("admin"))):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=MESSAGES_COLLECTION, query={}, projection={"_id": 0})
        accounts = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        names = {a.get("username"): (a.get("name") or a.get("username")) for a in accounts}
        for m in dataset:
            m["to_name"] = names.get(m.get("to_username"), m.get("to_username"))
        dataset = sorted(dataset, key=lambda m: m.get("created_at") or "", reverse=True)[:500]
        return {"message": "all messages", "dataset": dataset}
    except Exception:
        logging.error("team messages cannot be fetched")
        raise HTTPException(status_code=500, detail="team messages cannot be fetched")


@app.post("/message/read/{message_id}")
def message_mark_read(message_id: str, user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        db.update_data(collection_name=MESSAGES_COLLECTION, query={"message_id": message_id, "to_username": user["username"]},
                       update_values={"read": True})
        return {"message": "marked as read"}
    except Exception:
        logging.error("message could not be marked as read")
        raise HTTPException(status_code=500, detail="message could not be updated")


@app.post("/message/read_all")
def message_mark_all_read(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        unread = db.get_data(collection_name=MESSAGES_COLLECTION, query={"to_username": user["username"], "read": False}, projection={"_id": 0})
        for m in unread:
            db.update_data(collection_name=MESSAGES_COLLECTION, query={"message_id": m["message_id"], "to_username": user["username"]},
                           update_values={"read": True})
        return {"message": "all marked as read", "updated": len(unread)}
    except Exception:
        logging.error("messages could not be marked as read")
        raise HTTPException(status_code=500, detail="messages could not be updated")


def _chat_filter(me: str, other: str = None):
    if other is None:
        return {"$or": [{"from_username": me}, {"to_username": me}]}
    return {"$or": [
        {"from_username": me, "to_username": other},
        {"from_username": other, "to_username": me},
    ]}


@app.get("/message/conversations")
def message_conversations(user: dict = Depends(get_current_user)):
    try:
        me = user["username"]
        db = mongodbclient()
        msgs = db.get_data(collection_name=MESSAGES_COLLECTION, query=_chat_filter(me), projection={"_id": 0})
        accounts = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        names = {a.get("username"): (a.get("name") or a.get("username")) for a in accounts}
        roles = {a.get("username"): a.get("role") for a in accounts}
        for m in msgs:
            if m.get("to_username") == me and not m.get("delivered") and not m.get("read"):
                db.update_data(collection_name=MESSAGES_COLLECTION,
                               query={"message_id": m["message_id"], "to_username": me},
                               update_values={"delivered": True})
                m["delivered"] = True
        convs = {}
        for m in sorted(msgs, key=lambda x: x.get("created_at") or ""):
            mine = m.get("from_username") == me
            other = m.get("to_username") if mine else m.get("from_username")
            c = convs.setdefault(other, {"username": other, "name": names.get(other, other),
                                         "role": roles.get(other), "unread": 0, "last": None})
            c["last"] = {"body": m.get("body"), "created_at": m.get("created_at"), "mine": mine,
                         "read": bool(m.get("read")), "delivered": bool(m.get("delivered") or m.get("read"))}
            if not mine and not m.get("read"):
                c["unread"] += 1
        dataset = sorted(convs.values(), key=lambda c: c["last"]["created_at"] or "", reverse=True)
        return {"message": "conversations", "dataset": dataset}
    except Exception:
        logging.error("conversations cannot be fetched")
        raise HTTPException(status_code=500, detail="conversations cannot be fetched")


@app.get("/message/thread/{other}")
def message_thread(other: str, user: dict = Depends(get_current_user)):
    try:
        me = user["username"]
        db = mongodbclient()
        msgs = db.get_data(collection_name=MESSAGES_COLLECTION, query=_chat_filter(me, other), projection={"_id": 0})
        msgs = sorted(msgs, key=lambda m: m.get("created_at") or "")[-300:]
        now = datetime.now(timezone.utc).isoformat()
        for m in msgs:
            if m.get("to_username") == me and not m.get("read"):
                db.update_data(collection_name=MESSAGES_COLLECTION,
                               query={"message_id": m["message_id"], "to_username": me},
                               update_values={"read": True, "delivered": True, "read_at": now})
                m["read"] = True
                m["delivered"] = True
                m["read_at"] = now
            m["mine"] = m.get("from_username") == me
            m["delivered"] = bool(m.get("delivered") or m.get("read"))
        return {"message": "thread", "dataset": msgs}
    except Exception:
        logging.error("thread cannot be fetched")
        raise HTTPException(status_code=500, detail="thread cannot be fetched")


WORK_COLLECTION = params.get("work_collection_name", "work_assignments")
WORK_STATUSES = {"open": "Open", "in_progress": "In Progress", "done": "Done"}
WORK_PRIORITIES = {"low", "normal", "high", "urgent"}

# Only these two usernames may assign / manage work (whatever their role is, even admin).
# Everybody else can only receive work, reply and update its status.
WORK_MANAGERS = {"prashant", "arun"}
# an unfinished work pops up again on the assignee's screen after this many hours,
# and keeps coming back every time this many hours pass, until it is marked Done
WORK_REMIND_HOURS = 24


def _is_work_manager(user) -> bool:
    return str((user or {}).get("username") or "").strip().lower() in WORK_MANAGERS


def require_work_manager(user: dict = Depends(get_current_user)):
    if not _is_work_manager(user):
        raise HTTPException(status_code=403, detail="Only Director can assign work")
    return user


def _work_parse_time(value):
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _work_popup_due(work, now) -> bool:
    """True when the assignee must be shown this work's window right now."""
    if work.get("status") == "done":
        return False
    if work.get("popup_pending"):
        return True
    last = _work_parse_time(work.get("last_popup_at") or work.get("seen_at") or work.get("created_at"))
    return last is None or (now - last) >= timedelta(hours=WORK_REMIND_HOURS)


class WorkAssignRequest(BaseModel):
    assigned_to: str
    title: str
    description: Optional[str] = ""
    priority: Optional[str] = "normal"
    due_date: Optional[str] = None


class WorkReplyRequest(BaseModel):
    body: str


class WorkStatusRequest(BaseModel):
    status: str


def _work_get(db, work_id: str):
    found = db.get_data(collection_name=WORK_COLLECTION, query={"work_id": work_id}, projection={"_id": 0})
    return found[0] if found else None


def _work_user_name(db, username: str) -> str:
    found = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
    return (found[0].get("name") or username) if found else username


def _work_check_access(work, user):
    if not work:
        raise HTTPException(status_code=404, detail="work not found")
    if not _is_work_manager(user) and work.get("assigned_to") != user["username"]:
        raise HTTPException(status_code=403, detail="you do not have permission for this action")


@app.post("/work/assign")
def work_assign(request: WorkAssignRequest, user: dict = Depends(require_work_manager)):
    title = (request.title or "").strip()
    description = (request.description or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="work title is required")
    if len(title) > 120:
        raise HTTPException(status_code=400, detail="title is too long (max 120 characters)")
    if len(description) > 2000:
        raise HTTPException(status_code=400, detail="description is too long (max 2000 characters)")
    priority = request.priority if request.priority in WORK_PRIORITIES else "normal"
    try:
        db = mongodbclient()
        target = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={"username": request.assigned_to})
        if not target:
            raise HTTPException(status_code=404, detail="user not found")
        if str(request.assigned_to).strip().lower() in WORK_MANAGERS:
            raise HTTPException(status_code=400, detail="work cannot be assigned to a work manager")
        now = datetime.now(timezone.utc).isoformat()
        work_id = uuid.uuid4().hex
        db.add(collection_name=WORK_COLLECTION, dictionary={
            "work_id": work_id,
            "title": title,
            "description": description,
            "priority": priority,
            "due_date": request.due_date or None,
            "assigned_to": request.assigned_to,
            "assigned_to_name": target[0].get("name") or request.assigned_to,
            "assigned_to_role": target[0].get("role"),
            "assigned_by": user["username"],
            "assigned_by_name": _work_user_name(db, user["username"]),
            "status": "open",
            "popup_pending": True,
            "assignee_unread": True,
            "admin_unread": False,
            "seen_at": None,
            "last_popup_at": None,
            "replies": [],
            "created_at": now,
            "updated_at": now,
        })
        logging.info(f"work {work_id} assigned by {user['username']} to {request.assigned_to}")
        return {"message": "work assigned", "work_id": work_id}
    except HTTPException:
        raise
    except Exception:
        logging.error("work could not be assigned")
        raise HTTPException(status_code=500, detail="work could not be assigned")


@app.get("/work/all")
def work_all(user: dict = Depends(require_work_manager)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=WORK_COLLECTION, query={}, projection={"_id": 0})
        dataset.sort(key=lambda w: w.get("updated_at") or w.get("created_at") or "", reverse=True)
        return {"message": "work list", "dataset": dataset}
    except Exception:
        logging.error("work list cannot be fetched")
        raise HTTPException(status_code=500, detail="work list cannot be fetched")


@app.get("/work/mine")
def work_mine(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=WORK_COLLECTION, query={"assigned_to": user["username"]}, projection={"_id": 0})
        dataset.sort(key=lambda w: w.get("updated_at") or w.get("created_at") or "", reverse=True)
        return {"message": "my work", "dataset": dataset}
    except Exception:
        logging.error("work cannot be fetched")
        raise HTTPException(status_code=500, detail="work cannot be fetched")


@app.get("/work/popup")
def work_popup(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        if _is_work_manager(user):
            return {"message": "work popup", "dataset": []}
        now = datetime.now(timezone.utc)
        dataset = db.get_data(collection_name=WORK_COLLECTION,
                              query={"assigned_to": user["username"], "status": {"$ne": "done"}}, projection={"_id": 0})
        due = []
        for w in dataset:
            if _work_popup_due(w, now):
                # "reminder" = this window was already shown before and the work is still not done
                w["popup_kind"] = "reminder" if w.get("last_popup_at") and not w.get("popup_pending") else "new"
                due.append(w)
        due.sort(key=lambda w: w.get("updated_at") or w.get("created_at") or "")
        return {"message": "work popup", "dataset": due}
    except Exception:
        logging.error("work popup cannot be fetched")
        raise HTTPException(status_code=500, detail="work popup cannot be fetched")


@app.post("/work/{work_id}/seen")
def work_seen(work_id: str, user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        work = _work_get(db, work_id)
        _work_check_access(work, user)
        if not _is_work_manager(user):
            now_iso = datetime.now(timezone.utc).isoformat()
            db.update_data(collection_name=WORK_COLLECTION, query={"work_id": work_id},
                           update_values={"popup_pending": False, "last_popup_at": now_iso,
                                          "seen_at": work.get("seen_at") or now_iso})
        return {"message": "work seen"}
    except HTTPException:
        raise
    except Exception:
        logging.error("work seen could not be saved")
        raise HTTPException(status_code=500, detail="work could not be updated")


@app.get("/work/{work_id}")
def work_detail(work_id: str, user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        work = _work_get(db, work_id)
        _work_check_access(work, user)
        if _is_work_manager(user):
            if work.get("admin_unread"):
                db.update_data(collection_name=WORK_COLLECTION, query={"work_id": work_id}, update_values={"admin_unread": False})
                work["admin_unread"] = False
        elif work.get("assignee_unread") or not work.get("seen_at"):
            seen = work.get("seen_at") or datetime.now(timezone.utc).isoformat()
            db.update_data(collection_name=WORK_COLLECTION, query={"work_id": work_id},
                           update_values={"assignee_unread": False, "seen_at": seen})
            work["assignee_unread"] = False
            work["seen_at"] = seen
        return {"message": "work detail", "work": work}
    except HTTPException:
        raise
    except Exception:
        logging.error("work detail cannot be fetched")
        raise HTTPException(status_code=500, detail="work cannot be fetched")


@app.post("/work/{work_id}/reply")
def work_reply(work_id: str, request: WorkReplyRequest, user: dict = Depends(get_current_user)):
    body = (request.body or "").strip()
    if not body:
        raise HTTPException(status_code=400, detail="reply cannot be empty")
    if len(body) > 2000:
        raise HTTPException(status_code=400, detail="reply is too long (max 2000 characters)")
    try:
        db = mongodbclient()
        work = _work_get(db, work_id)
        _work_check_access(work, user)
        now = datetime.now(timezone.utc).isoformat()
        replies = list(work.get("replies") or [])
        replies.append({
            "reply_id": uuid.uuid4().hex,
            "type": "message",
            "by": user["username"],
            "by_name": _work_user_name(db, user["username"]),
            "by_role": user["role"],
            "body": body,
            "created_at": now,
        })
        update = {"replies": replies, "updated_at": now}
        if _is_work_manager(user):
            update["popup_pending"] = True
            update["assignee_unread"] = True
        else:
            update["admin_unread"] = True
            if work.get("status") == "open":
                update["status"] = "in_progress"
        db.update_data(collection_name=WORK_COLLECTION, query={"work_id": work_id}, update_values=update)
        return {"message": "reply sent"}
    except HTTPException:
        raise
    except Exception:
        logging.error("work reply could not be sent")
        raise HTTPException(status_code=500, detail="reply could not be sent")


@app.post("/work/{work_id}/status")
def work_status(work_id: str, request: WorkStatusRequest, user: dict = Depends(get_current_user)):
    if request.status not in WORK_STATUSES:
        raise HTTPException(status_code=400, detail="invalid status")
    try:
        db = mongodbclient()
        work = _work_get(db, work_id)
        _work_check_access(work, user)
        now = datetime.now(timezone.utc).isoformat()
        name = _work_user_name(db, user["username"])
        replies = list(work.get("replies") or [])
        replies.append({
            "reply_id": uuid.uuid4().hex,
            "type": "system",
            "by": user["username"],
            "by_name": name,
            "by_role": user["role"],
            "body": f"{name} marked this work as {WORK_STATUSES[request.status]}",
            "created_at": now,
        })
        update = {"status": request.status, "replies": replies, "updated_at": now}
        if work.get("status") == "done" and request.status != "done":
            update["last_popup_at"] = now      # reopened: the 24 hour reminder clock starts again
        if _is_work_manager(user):
            update["assignee_unread"] = True
        else:
            update["admin_unread"] = True
        db.update_data(collection_name=WORK_COLLECTION, query={"work_id": work_id}, update_values=update)
        return {"message": "status updated"}
    except HTTPException:
        raise
    except Exception:
        logging.error("work status could not be updated")
        raise HTTPException(status_code=500, detail="status could not be updated")


app.mount("/css", StaticFiles(directory=os.path.join(BASE_DIR, "css")), name="css")
app.mount("/images", StaticFiles(directory=os.path.join(BASE_DIR, "images")), name="images")
app.mount("/pages", StaticFiles(directory=os.path.join(BASE_DIR, "pages"), html=True), name="pages")

app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="root")