from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from bson import ObjectId
from logger import logging
from configuration import load_params
from dotenv import load_dotenv
from mongodb.mongodb_connection import mongodbclient
from user.company import login
from order.manage_order import order_manager
from service.service_details import service_detail, GDRIVE_PLACEHOLDER
from gdrive_media import upload_base64_to_drive
from inventory.inventory_handling import inventory_manager
from user.customer_details import customer_manager
from sales.sales_person_manager import sales_person_manager
from allocation.allocation import allocation_manager
from request.request_manager import request_manager
from shipment.manage_shipment import shipment_manager
from assembly.manage_assembly import assembly_manager
from auth import create_access_token, get_current_user, require_role
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import os
import re
import uuid
import base64
import smtplib
from email.message import EmailMessage
from datetime import datetime, timezone, timedelta


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
ORDERS_COLLECTION = params["order_collection_name"]
SERVICE_COLLECTION = params["service_collection_name"]
INVENTORY_COLLECTION = params["inventory_collection_name"]
CUSTOMER_COLLECTION = params.get("customer_collection_name", "customers")
SALESPERSON_COLLECTION = params.get("salesperson_collection_name", "sales_persons")
ALLOCATION_COLLECTION = params.get("allocation_collection_name", "allocations")
REQUESTS_COLLECTION = params.get("requests_collection_name", "requests")
SHIPMENT_COLLECTION = params.get("shipment_collection_name", "shipments")
ASSEMBLY_COLLECTION = params.get("assembly_collection_name", "assemblies")

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
    role: str


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
    serial_no: str
    technician_id: str
    purchase_date: str
    issue: str
    image: str
    video: str
    location: str = "indoor"
    spare_parts: str = ""


class OrderItem(BaseModel):
    product_id: str
    product_name: str
    quantity: int
    price: float
    tax_rate: float = 0


class CreateOrderRequest(BaseModel):
    customer_id: str = ""          # set when an existing customer was picked
    customer: dict = {}            # denormalized snapshot: company_name, company_address,
                                    # gst_number, contractor_person, contractor_number, contractor_email
    items: list[OrderItem]
    payment_mode: str
    payment_details: dict = {}     # credit_days / cheque_number+cheque_date / dd_number+dd_date etc.
    discount: float = 0


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


class SparePartAllocation(BaseModel):
    service_id: str
    part_name: str
    quantity: int = 1


class CreateAllocationRequest(BaseModel):
    sales_person_id: str = ""
    sales_person: dict = {}
    items: list[AllocationItem] = []
    spare_part: SparePartAllocation | None = None
    company_name: str = ""
    address: str = ""


class CreateDemoUnitRequest(BaseModel):
    customer_id: str = ""
    customer: dict = {}
    items: list[AllocationItem]


class OrderStatusRequest(BaseModel):
    order_id: str


class DispatchConfirmRequest(BaseModel):
    docket_no: Optional[str] = None
    invoice_no: str
    invoice_date: str
    mode_of_delivery: Optional[str] = None
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
    serial_numbers: list[str] = []
    product_type: str = "product"  # "product" | "spare_parts" | "service_parts" | "damaged" | "accessories"


class InventoryUpdateRequest(BaseModel):
    updated_values: dict
    new_serial_numbers: list[str] = []
    remove_serial_numbers: list[str] = []
    new_hologram_numbers: list[str] = []      # serial-wise hologram numbers to add (spare_parts / service_parts only)
    remove_hologram_numbers: list[str] = []
    model_no: Optional[str] = None   # disambiguates which lot-document to touch when a product_id has multiple model_no variants


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
    dispatch_date: str
    received_date: str = ""       # optional - can be added later via mark_received
    products: list[ShipmentProduct]


class ShipmentReceivedRequest(BaseModel):
    received_date: str


class ShipmentUpdateRequest(BaseModel):
    updated_values: dict


class AssemblyPartUsed(BaseModel):
    part_name: str
    quantity: int = 0
    source: str = "inventory"     # "inventory" (deduct from inventory's spare_parts stock) | "local" (sourced outside, no deduction)


class AssemblySerialItem(BaseModel):
    serial_number: str


class CreateAssemblyRequest(BaseModel):
    product_name: str
    product_id: str = ""
    model_number: str = ""
    quantity: int
    parts_used: list[AssemblyPartUsed] = []
    serials: list[AssemblySerialItem]


class AssemblyUpdateRequest(BaseModel):
    updated_values: dict


@app.get("/")
async def home():
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.get("/main_dashboard.html")
async def dashboard():
    return FileResponse(os.path.join(BASE_DIR, "main_dashboard.html"))


@app.post("/login/")
async def login_page(request: LoginRequest):
    try:
        db = login()
        dataset = db.get_data(ACCOUNTS_COLLECTION, query={"username": request.username})

        if not dataset:
            raise HTTPException(
                status_code=404,
                detail="username was not registered! please create account before login."
            )

        user = dataset[0]

        if user["password"] != request.password or user["role"] != request.role:
            raise HTTPException(status_code=401, detail="details did not match")

        token = create_access_token(username=user["username"], role=user["role"])

        return {
            "message": "access granted",
            "role": user["role"],
            "access_token": token,
            "token_type": "bearer"
        }

    except HTTPException:
        raise
    except Exception as e:
        logging.error("login was not successful")
        raise HTTPException(status_code=500, detail="login failed")


@app.get("/account/")
async def account(user: dict = Depends(get_current_user)):
    try:
        db = mongodbclient()
        dataset = db.get_data(collection_name=ACCOUNTS_COLLECTION, query={})
        logging.info("account dataset was fetched successfully")
        return {"message": "account dataset", "dataset": dataset}
    except Exception as e:
        logging.error("account dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="account informations cannot be fetched")


@app.get("/account/my_team")
async def my_team(user: dict = Depends(require_role("distributor"))):
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
async def team_allocations(user: dict = Depends(require_role("distributor"))):
    try:
        acc_db = mongodbclient()
        team = acc_db.get_data(collection_name=ACCOUNTS_COLLECTION,
                                query={"role": "distributor", "manager": user["username"]})
        team_usernames = [t["username"] for t in team]
        if not team_usernames:
            return {"message": "no team members", "dataset": []}

        alloc_db = allocation_manager()
        dataset = alloc_db.get_data(collection_name=ALLOCATION_COLLECTION,
                                     query={"allocation_type": "demo_unit", "allocated_by": {"$in": team_usernames}})
        return {"message": "team demo unit allocations", "dataset": dataset}
    except Exception as e:
        logging.error("fetching team allocations failed")
        raise HTTPException(status_code=500, detail="team allocations cannot be fetched")


@app.get("/account/technicians")
async def list_technicians(user: dict = Depends(get_current_user)):
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
async def list_distributors(user: dict = Depends(get_current_user)):
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


@app.post("/account/create_account/")
async def create_account(request: CreateAccountRequest, user: dict = Depends(require_role("admin"))):
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
        logging.error("account creation was failed!")
        raise HTTPException(status_code=500, detail="account creation failed")


@app.post("/login/delete_account/{username}")
async def delete_account(username: str, user: dict = Depends(require_role("admin"))):
    try:
        db = login()
        db.delete(collection_name=ACCOUNTS_COLLECTION, query={"username": username})
        logging.info("account deleted successfully")
        return {"message": "account was deleted successfully", "username": username}

    except Exception as e:
        logging.error("account cannot be deleted.")
        raise HTTPException(status_code=500, detail="account cannot be deleted")


@app.post("/login/update_account/{username}")
async def update_account(username: str, updated_values: UpdateAccountRequest, user: dict = Depends(require_role("admin"))):
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


VALID_PAYMENT_MODES = {"Credit", "NetBanking", "UPI", "Cheque", "DemandDraft", "Cash"}


def _raise_media_review_request(service_id: str, raised_by: str):
    """Creates a 'media_review' request so admin/employee get a bell notification
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

        inv_db = inventory_manager(product_name=part_name, product_id=old_hologram,
                                    quantity=1, product_type="damaged",
                                    warranty_until=warranty_until, reason=reason)
        inv_db.add(collection_name=INVENTORY_COLLECTION)

    if assembly is not None and serials is not None:
        asm_db.update(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly["assembly_id"]},
                      update_values={"serials": serials})

    logging.info(f"faulty part(s) swapped for service {service_id}: {len(parts_used)} part(s) processed")
    return mismatch


def _fulfill_order(customer_id: str, customer: dict, items: list, payment_mode: str, payment_details: dict, discount: float, creator: dict = None):
    """Validates payment details, resolves/creates the customer, deducts stock + serials,
    and creates the order record. Shared by the direct /order/create_order/ endpoint and by
    /request/approve/{request_id} when a distributor's order request is approved."""
    if not items:
        raise HTTPException(status_code=400, detail="add at least one product to the order")

    if payment_mode not in VALID_PAYMENT_MODES:
        raise HTTPException(status_code=400, detail="invalid payment mode")

    if payment_mode == "Credit":
        credit_days = payment_details.get("credit_days")
        if not credit_days or not (0 < int(credit_days) <= 60):
            raise HTTPException(status_code=400, detail="credit days must be between 1 and 60")

    if payment_mode == "Cheque" and not payment_details.get("cheque_number"):
        raise HTTPException(status_code=400, detail="cheque number is required")

    if payment_mode == "DemandDraft" and not payment_details.get("dd_number"):
        raise HTTPException(status_code=400, detail="demand draft number is required")

    if payment_mode == "UPI" and not payment_details.get("upi_id"):
        raise HTTPException(status_code=400, detail="UPI ID is required")

    if payment_mode == "NetBanking" and not (
        payment_details.get("bank_name")
        and payment_details.get("account_number")
        and payment_details.get("ifsc_code")
    ):
        raise HTTPException(status_code=400, detail="bank name, account number and IFSC code are required")

    if payment_mode == "Cash" and not payment_details.get("received_by"):
        raise HTTPException(status_code=400, detail="received-by person name is required")

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

    # pre-check availability for every line before mutating any inventory
    for item in items:
        available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item["product_id"])
        if available < item["quantity"]:
            raise HTTPException(
                status_code=400,
                detail=f"insufficient stock for {item.get('product_name', item['product_id'])}: only {available} available"
            )

    order_items = []
    for item in items:
        allocated_serials = inventory_db.allocate_serials(
            collection_name=INVENTORY_COLLECTION,
            product_id=item["product_id"],
            quantity=item["quantity"]
        )
        order_item = dict(item)
        order_item["serial_numbers"] = allocated_serials
        order_items.append(order_item)

    order = order_manager(
        customer=customer_snapshot,
        items=order_items,
        payment_mode=payment_mode,
        payment_details=payment_details,
        discount=discount,
        creator=creator or {}
    )
    order.add(collection_name=ORDERS_COLLECTION)

    logging.info(f"order {order.order_id} created successfully")
    return order.order_id


@app.post("/order/create_order/")
async def create_order(request: CreateOrderRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        order_id = _fulfill_order(
            customer_id=request.customer_id,
            customer=request.customer,
            items=[item.dict() for item in request.items],
            payment_mode=request.payment_mode,
            payment_details=request.payment_details,
            discount=request.discount,
            creator={"type": "direct", "created_by": user["username"]}
        )
        return {"message": "order created successfully", "order_id": order_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("order creation failed!")
        raise HTTPException(status_code=500, detail="order creation failed")


@app.get("/track_order/{order_id}")
async def track_order(order_id: str, user: dict = Depends(get_current_user)):
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
async def confirm_delivery(order_id: str, user: dict = Depends(require_role("admin", "employee"))):
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
async def delete_order(order_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = order_manager()
        db.delete(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        return {"message": "order deleted", "order_id": order_id}
    except Exception as e:
        logging.error("order deletion failed")
        raise HTTPException(status_code=500, detail="order deletion failed!")


@app.post("/order/update/{order_id}")
async def update_order(order_id: str, updated_value: OrderUpdatedValue, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = order_manager()
        updated = dict(updated_value.updated_order_value)

        existing = db.get_data(collection_name=ORDERS_COLLECTION, query={"order_id": order_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no order found with this order_id")
        order = existing[0]

        # These fields actually live inside order["items"][0], not at the
        # top level of the order document — editing them has to go through
        # the item, or they silently land as an unused stray field and the
        # UI never reflects the change.
        item_field_keys = {"product_name", "serial_no", "quantity", "price", "tax_rate"}
        touched_item_fields = item_field_keys & updated.keys()
        if touched_item_fields:
            items = order.get("items", [])
            if not items:
                raise HTTPException(status_code=400, detail="order has no items to edit")
            item = dict(items[0])
            for key in touched_item_fields:
                item[key] = updated.pop(key)

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

        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id}, update_values=updated)
        logging.info("order value was updated successfully.")
        return {"message": "order value was updated", "order_id": order_id, "updated_value": updated}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order cannot be updated")
        raise HTTPException(status_code=500, detail="order value cannot be updated")


@app.get("/order/")
async def order(user: dict = Depends(get_current_user)):
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

@app.get("/shipment/")
async def shipment(user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = shipment_manager()
        dataset = db.get_data(collection_name=SHIPMENT_COLLECTION, query={})
        logging.info("shipment dataset was fetched successfully")
        return {"message": "shipment dataset", "dataset": dataset}
    except Exception as e:
        logging.error("shipment dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="shipment dataset cannot be fetched")


@app.get("/shipment/{shipment_id}")
async def track_shipment(shipment_id: str, user: dict = Depends(require_role("admin", "employee"))):
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
async def create_shipment(request: CreateShipmentRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        shipment_item = shipment_manager(
            company_name=request.company_name,
            company_address=request.company_address,
            dispatch_date=request.dispatch_date,
            received_date=request.received_date or None,
            products=[product.dict() for product in request.products],
            created_by=user["username"],
        )
        _, shipment_id = shipment_item.add(collection_name=SHIPMENT_COLLECTION)
        logging.info("shipment created successfully")
        return {"message": "shipment created successfully", "shipment_id": shipment_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment creation failed!")
        raise HTTPException(status_code=500, detail="shipment creation failed")


@app.post("/shipment/mark_received/{shipment_id}")
async def mark_shipment_received(shipment_id: str, request: ShipmentReceivedRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = shipment_manager()
        existing = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")

        shipment = existing[0]
        db.mark_received(collection_name=SHIPMENT_COLLECTION, shipment_id=shipment_id, received_date=request.received_date)

        # push this shipment's parts into inventory, bucketed by each part's
        # status: "assembly" parts -> inventory spare_parts, "purchase" and
        # "warranty" parts -> inventory service_parts (kept apart there via
        # part_category so the two never merge into one entry). Warranty parts
        # also get a warranty_until date computed from this product's warranty
        # duration + the shipment's received_date, so inventory can later show
        # them as "under warranty" / "over warranty".
        # Kept non-fatal: the shipment is already marked received above, so an
        # inventory hiccup here is reported back but doesn't roll that back.
        inventory_sync = "skipped"
        try:
            spare_parts_needed = {}      # (product_name, part_name) -> {"quantity": qty, "warranty_until": date|None}   (status == "assembly")
            purchase_parts_needed = {}   # (product_name, part_name) -> total qty   (status == "purchase")
            warranty_parts_needed = {}   # (product_name, part_name) -> {"quantity": qty, "warranty_until": date|None}

            for product in shipment.get("products", []):
                parent_product_name = product.get("product_name", "")
                product_warranty_until = compute_warranty_until(request.received_date, product.get("warranty", ""))
                for part in product.get("parts", []):
                    name = (part.get("part_name") or "").strip()
                    qty = part.get("quantity", 0) or 0
                    if not name or qty <= 0:
                        continue
                    status = part.get("status", "assembly")
                    key = (parent_product_name, name)

                    if status == "assembly":
                        # spare parts ship bundled with the product, so they're
                        # covered under that same product's warranty window
                        entry = spare_parts_needed.setdefault(key, {"quantity": 0, "warranty_until": None})
                        entry["quantity"] += qty
                        if product_warranty_until and (not entry["warranty_until"] or product_warranty_until > entry["warranty_until"]):
                            entry["warranty_until"] = product_warranty_until
                    elif status == "purchase":
                        purchase_parts_needed[key] = purchase_parts_needed.get(key, 0) + qty
                    else:  # "warranty"
                        entry = warranty_parts_needed.setdefault(key, {"quantity": 0, "warranty_until": None})
                        entry["quantity"] += qty
                        # if the same part shows up under multiple products, keep the
                        # furthest-out expiry so the part stays covered the longest possible
                        if product_warranty_until and (not entry["warranty_until"] or product_warranty_until > entry["warranty_until"]):
                            entry["warranty_until"] = product_warranty_until

            if spare_parts_needed or purchase_parts_needed or warranty_parts_needed:
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
                        purchase_date=request.received_date,
                    )
                if purchase_parts_needed:
                    sync_results += inv_db.add_from_shipment_parts(
                        collection_name=INVENTORY_COLLECTION,
                        parts=[{"part_name": n, "parent_product_name": pn, "quantity": q, "part_category": "purchase"}
                               for (pn, n), q in purchase_parts_needed.items()],
                        product_type="service_parts",
                        supplier=shipment.get("company_name", ""),
                        supplier_address=shipment.get("company_address", ""),
                        purchase_date=request.received_date,
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
                        purchase_date=request.received_date,
                    )
                inventory_sync = sync_results
            else:
                inventory_sync = "no_parts"
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
async def update_shipment(shipment_id: str, request: ShipmentUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = shipment_manager()
        existing = db.get_data(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no shipment found with this shipment_id")

        updated = dict(request.updated_values)
        # keep status in sync if the caller is editing received_date directly
        if "received_date" in updated:
            updated["status"] = "received" if updated["received_date"] else "pending"

        db.update(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id}, update_values=updated)
        logging.info("shipment value was updated successfully.")
        return {"message": "shipment value was updated", "shipment_id": shipment_id, "updated_value": updated}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("shipment cannot be updated")
        raise HTTPException(status_code=500, detail="shipment value cannot be updated")


@app.post("/shipment/delete/{shipment_id}")
async def delete_shipment(shipment_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = shipment_manager()
        db.delete(collection_name=SHIPMENT_COLLECTION, query={"shipment_id": shipment_id})
        return {"message": "shipment deleted", "shipment_id": shipment_id}
    except Exception as e:
        logging.error("shipment deletion failed")
        raise HTTPException(status_code=500, detail="shipment deletion failed!")


# =========================================================
# ASSEMBLY
# =========================================================

@app.get("/assembly/")
async def assembly(user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = assembly_manager()
        dataset = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={})
        logging.info("assembly dataset was fetched successfully")
        return {"message": "assembly dataset", "dataset": dataset}
    except Exception as e:
        logging.error("assembly dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="assembly dataset cannot be fetched")


@app.get("/assembly/available_parts")
async def available_parts_for_assembly(user: dict = Depends(require_role("admin", "employee"))):
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
            agg = pool.setdefault(name, {"quantity": 0, "hologram_available": 0})
            agg["quantity"] += qty
            agg["hologram_available"] += hologram_count

        available = [
            {"part_name": name, "quantity": v["quantity"], "hologram_available": v["hologram_available"]}
            for name, v in pool.items()
        ]
        return {"message": "available parts", "dataset": available}
    except Exception as e:
        logging.error("available parts for assembly cannot be fetched")
        raise HTTPException(status_code=500, detail="available parts cannot be fetched")


@app.get("/assembly/{assembly_id}")
async def track_assembly(assembly_id: str, user: dict = Depends(require_role("admin", "employee"))):
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
async def create_assembly(request: CreateAssemblyRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        parts_used = [part.dict() for part in request.parts_used]

        if len(request.serials) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match the assembly quantity")
        serial_values = [s.serial_number.strip() for s in request.serials]
        if any(not s for s in serial_values):
            raise HTTPException(status_code=400, detail="every unit needs a serial number")
        if len(set(serial_values)) != len(serial_values):
            raise HTTPException(status_code=400, detail="serial numbers must be unique within this batch")

        # sum up everything sourced from inventory, merging duplicate part names
        needed_from_inventory: dict[str, int] = {}
        for p in parts_used:
            if p["source"] != "inventory" or p["quantity"] <= 0:
                continue
            needed_from_inventory[p["part_name"]] = needed_from_inventory.get(p["part_name"], 0) + p["quantity"]

        if not needed_from_inventory:
            raise HTTPException(
                status_code=400,
                detail="add at least one part from inventory — its hologram numbers supply the assembled units' hologram numbers",
            )

        # exactly one inventory part must be used at a 1:1 ratio with the assembly
        # quantity — that's the hologram-bearing part, and its hologram numbers
        # (one per unit) become each finished unit's hologram number
        hologram_candidates = [name for name, qty in needed_from_inventory.items() if qty == request.quantity]
        if len(hologram_candidates) != 1:
            raise HTTPException(
                status_code=400,
                detail="exactly one part from inventory must have quantity equal to the assembly quantity — "
                       "that part supplies the hologram number for each assembled unit",
            )
        hologram_part_name = hologram_candidates[0]

        inv_db = inventory_manager()

        # validate stock (and, for the hologram part, hologram numbers on file) is
        # sufficient for EVERY part before deducting any of them — otherwise a
        # shortage on part #2 would leave part #1 already (irreversibly) deducted
        for part_name, qty in needed_from_inventory.items():
            have = inv_db.get_available_quantity_by_name(
                collection_name=INVENTORY_COLLECTION, product_name=part_name, product_type="spare_parts"
            )
            if have < qty:
                raise HTTPException(
                    status_code=400,
                    detail=f"not enough '{part_name}' in inventory spare parts (need {qty}, have {have})",
                )
            if part_name == hologram_part_name:
                hologram_have = inv_db.get_hologram_available_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name, product_type="spare_parts"
                )
                if hologram_have < qty:
                    raise HTTPException(
                        status_code=400,
                        detail=f"not enough hologram-tagged '{part_name}' in inventory (need {qty}, have {hologram_have})",
                    )

        # stock confirmed for every part — now actually deduct
        hologram_numbers: list[str] = []
        for part_name, qty in needed_from_inventory.items():
            if part_name == hologram_part_name:
                hologram_numbers = inv_db.allocate_hologram_numbers_by_name(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name,
                    product_type="spare_parts", quantity=qty,
                )
            else:
                inv_db.consume_quantity(
                    collection_name=INVENTORY_COLLECTION, product_name=part_name,
                    product_type="spare_parts", quantity=qty,
                )

        if len(hologram_numbers) != request.quantity:
            raise HTTPException(status_code=500, detail="could not allocate a hologram number for every assembled unit")

        serials = [
            {"serial_number": s.serial_number.strip(), "hologram_number": hologram_numbers[i]}
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
        )
        _, assembly_id = assembly_item.add(collection_name=ASSEMBLY_COLLECTION)
        logging.info("assembly created successfully")
        return {"message": "assembly created successfully", "assembly_id": assembly_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("assembly creation failed!")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/assembly/mark_completed/{assembly_id}")
async def mark_assembly_completed(assembly_id: str, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = assembly_manager()
        existing = db.get_data(collection_name=ASSEMBLY_COLLECTION, query={"assembly_id": assembly_id})
        if not existing:
            raise HTTPException(status_code=404, detail="no assembly found with this assembly_id")
        assembly = existing[0]

        db.mark_completed(collection_name=ASSEMBLY_COLLECTION, assembly_id=assembly_id)

        # push the freshly built units into inventory - merges into a matching
        # product_name + product_id + model_no entry if one exists, else creates one.
        # Kept non-fatal: the assembly is already marked completed above, so an
        # inventory hiccup here is reported back but doesn't roll that back.
        inventory_sync = "skipped"
        try:
            serial_numbers = [s.get("serial_number") for s in assembly.get("serials", []) if s.get("serial_number")]
            inv_db = inventory_manager()
            sync_result = inv_db.add_from_assembly(
                collection_name=INVENTORY_COLLECTION,
                product_name=assembly.get("product_name"),
                product_id=assembly.get("product_id"),
                model_no=assembly.get("model_number"),
                quantity=assembly.get("quantity", 0),
                serial_numbers=serial_numbers,
                purchase_date=datetime.now(timezone.utc).date().isoformat(),
            )
            inventory_sync = sync_result["mode"]  # "merged" | "created"
        except Exception as inv_err:
            logging.error(f"assembly {assembly_id} completed but inventory sync failed: {inv_err}")
            inventory_sync = f"failed: {inv_err}"

        return {"message": "assembly marked as completed", "assembly_id": assembly_id, "inventory_sync": inventory_sync}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("marking assembly as completed failed")
        raise HTTPException(status_code=500, detail="assembly could not be marked as completed")


@app.post("/assembly/update/{assembly_id}")
async def update_assembly(assembly_id: str, request: AssemblyUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
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


@app.post("/assembly/delete/{assembly_id}")
async def delete_assembly(assembly_id: str, user: dict = Depends(require_role("admin"))):
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
async def dispatch_queue(user: dict = Depends(require_role("admin", "employee"))):
    try:
        migrate_stale_dispatch_media()
        odb = order_manager()
        all_orders = odb.get_data(collection_name=ORDERS_COLLECTION, query={"status": "processing"})
        pending_orders = [o for o in all_orders if not o.get("dispatch")]

        adb = allocation_manager()
        all_spare = adb.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_type": "spare_part"})
        pending_spare = [a for a in all_spare if not a.get("dispatch")]

        dispatched_orders = [o for o in all_orders if o.get("dispatch")]
        dispatched_spare = [a for a in all_spare if a.get("dispatch")]

        logging.info("dispatch queue was fetched successfully")
        return {
            "message": "dispatch queue",
            "pending_orders": pending_orders,
            "pending_spare_parts": pending_spare,
            "dispatched_orders": dispatched_orders,
            "dispatched_spare_parts": dispatched_spare
        }
    except Exception as e:
        logging.error("dispatch queue could not be fetched")
        raise HTTPException(status_code=500, detail="dispatch queue could not be fetched")


@app.post("/dispatch/confirm/order/{order_id}")
async def confirm_order_dispatch(order_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("admin", "employee"))):
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
            "dispatched_by": user["username"]
        }
        db.update(collection_name=ORDERS_COLLECTION, query={"order_id": order_id}, update_values={"dispatch": dispatch_info})
        logging.info(f"order {order_id} dispatch confirmed")
        return {"message": "dispatch confirmed", "order_id": order_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("order dispatch confirmation failed")
        raise HTTPException(status_code=500, detail="dispatch could not be confirmed")


@app.post("/dispatch/confirm/spare_part/{allocation_id}")
async def confirm_spare_part_dispatch(allocation_id: str, request: DispatchConfirmRequest, user: dict = Depends(require_role("admin", "employee"))):
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
async def services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={})
        logging.info("service dataset was fetched successfully")
        return {"message": "service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/services/create")
async def create_service(request: ServiceRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        service = service_detail(product_id=request.product_id, serial_no=request.serial_no)
        service.add_service(
            collection_name=SERVICE_COLLECTION,
            purchase_date=request.purchase_date,
            issue=request.issue,
            image=request.image,
            video=request.video,
            technician_id=request.technician_id,
            location=request.location,
            spare_parts=request.spare_parts
        )
        logging.info(f"service creation was successful with service_id {service.service_id}!")

        if request.video:
            _raise_media_review_request(service.service_id, user["username"])

        return {"message": "service creation was successful!", "service_id": service.service_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("service creation failed!")
        raise HTTPException(status_code=500, detail="service cannot be created!")


@app.post("/service/delete/{service_id}")
async def delete_service(service_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.delete_service(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        logging.info(f"service was deleted successfully service id {service_id}")
        return {"message": "service deletion was successful", "service_id": service_id}
    except Exception as e:
        logging.error("service deletion was failed!")
        raise HTTPException(status_code=500, detail="service cannot be deleted")


@app.post("/service/update/{service_id}")
async def update_service(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
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
        # since admin/employee just applied the change directly from the Service page
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


@app.post("/service/request_status_update/{service_id}")
async def request_status_update(service_id: str, request: ServiceUpdateRequest, user: dict = Depends(require_role("admin", "employee", "technician", "distributor"))):
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
async def my_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION, query={"technician_alloted": user["username"]})
        logging.info(f"service dataset fetched for technician {user['username']}")
        return {"message": "my service dataset", "dataset": dataset}
    except Exception as e:
        logging.error("technician service dataset cannot be fetched")
        raise HTTPException(status_code=500, detail="service dataset cannot be fetched")


@app.post("/service/update_charges/{service_id}")
async def update_service_charges(service_id: str, request: ServiceChargeRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = service_detail()
        db.set_service_charges(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, service_charges=request.service_charges)
        return {"message": "service charges updated", "service_id": service_id, "service_charges": request.service_charges}
    except Exception as e:
        logging.error("service charges update failed!")
        raise HTTPException(status_code=500, detail="service charges cannot be updated")


@app.post("/service/upload_media/{service_id}")
async def upload_service_media(service_id: str, request: ServiceMediaRequest, user: dict = Depends(require_role("admin", "employee", "technician", "distributor"))):
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
async def request_spare_part(service_id: str, request: SparePartRequest, user: dict = Depends(require_role("admin", "employee", "technician", "distributor"))):
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
async def manager_confirm(service_id: str, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.manager_confirm_return(collection_name=SERVICE_COLLECTION, query={"service_id": service_id})
        return {"message": "manager confirmed part return", "service_id": service_id}
    except Exception as e:
        logging.error("manager confirmation failed!")
        raise HTTPException(status_code=500, detail="manager confirmation failed")


@app.post("/service/extend_warranty/{service_id}")
async def extend_warranty(service_id: str, request: ExtendWarrantyRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = service_detail(product_id="", serial_no="")
        db.extend_warranty(collection_name=SERVICE_COLLECTION, query={"service_id": service_id}, warranty_until=request.warranty_until)
        return {"message": "warranty extended", "service_id": service_id, "warranty_until": request.warranty_until}
    except Exception as e:
        logging.error("warranty extension failed!")
        raise HTTPException(status_code=500, detail="warranty extension failed")


@app.get("/inventory/")
async def inventory(user: dict = Depends(get_current_user)):
    try:
        db = inventory_manager()
        dataset = db.get_data(collection_name=INVENTORY_COLLECTION, query={})

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


@app.post("/inventory/create")
async def create_inventory(request: InventoryRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        # serial numbers are optional for accessories — only enforce the
        # quantity match when at least one serial number was actually given
        serials_required = request.product_type != "accessories" or len(request.serial_numbers) > 0
        if serials_required and len(request.serial_numbers) != request.quantity:
            raise HTTPException(status_code=400, detail="number of serial numbers must match quantity")
        if len(set(request.serial_numbers)) != len(request.serial_numbers):
            raise HTTPException(status_code=400, detail="serial numbers must be unique")

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
            serial_numbers=request.serial_numbers,
            product_type=request.product_type
        )
        inventory_item.add_or_merge(collection_name=INVENTORY_COLLECTION)
        logging.info("product listed successfully on inventory")
        return {"message": "product was listed successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("product cannot be listed to the inventory")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/inventory/update/{product_id}")
async def update_inventory(product_id: str, request: InventoryUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = inventory_manager()
        match_query = {"product_id": product_id}
        if request.model_no is not None:
            match_query["model_no"] = request.model_no
        existing = db.get_data(collection_name=INVENTORY_COLLECTION, query=match_query)
        if not existing:
            raise HTTPException(status_code=404, detail="product not found")
        current_serials = existing[0].get("serial_numbers") or []
        current_type = existing[0].get("product_type", "product")

        updated_values = dict(request.updated_values)
        effective_type = updated_values.get("product_type", current_type)

        # serial numbers are optional for accessories / spare_parts / service_parts,
        # so quantity is free to move independently of the serial list for those
        # types — only sync serials with quantity for product/damaged
        if effective_type in ("accessories", "spare_parts", "service_parts"):
            if request.new_serial_numbers:
                if len(set(request.new_serial_numbers)) != len(request.new_serial_numbers):
                    raise HTTPException(status_code=400, detail="new serial numbers must be unique")
                duplicates = [s for s in request.new_serial_numbers if s in current_serials]
                if duplicates:
                    raise HTTPException(status_code=400,
                                         detail=f"serial number(s) already exist on this product: {', '.join(duplicates)}")
            serials = list(current_serials)
            if request.remove_serial_numbers:
                serials = [s for s in serials if s not in request.remove_serial_numbers]
            if request.new_serial_numbers:
                serials = serials + request.new_serial_numbers
            if request.remove_serial_numbers or request.new_serial_numbers:
                updated_values["serial_numbers"] = serials

        # whenever quantity changes, keep serial_numbers in sync instead of letting
        # them silently drift out of step with the stock count
        elif "quantity" in updated_values and updated_values["quantity"] is not None:
            new_quantity = int(updated_values["quantity"])
            serials = list(current_serials)

            if request.remove_serial_numbers:
                missing = [s for s in request.remove_serial_numbers if s not in serials]
                if missing:
                    raise HTTPException(status_code=400,
                                         detail=f"serial number(s) not found on this product: {', '.join(missing)}")
                serials = [s for s in serials if s not in request.remove_serial_numbers]

            if request.new_serial_numbers:
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
                if len(set(incoming)) != len(incoming):
                    raise HTTPException(status_code=400, detail="uploaded hologram numbers contain duplicates")
                dup = [h for h in incoming if h in current_hologram]
                if dup:
                    raise HTTPException(status_code=400,
                                         detail=f"hologram number(s) already on file: {', '.join(dup)}")
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

        db.update(collection_name=INVENTORY_COLLECTION, query=match_query,
                   update_values=updated_values)
        logging.info("inventory was updated")
        return {
            "message": "inventory was updated successfully",
            "product_id": product_id,
            "hologram_added": hologram_added,
            "hologram_leftover": hologram_leftover
        }
    except HTTPException:
        raise
    except Exception as e:
        logging.error("inventory updation was unsuccessful!")
        raise HTTPException(status_code=500, detail="inventory cannot be updated")


@app.post("/inventory/delete/{product_id}")
async def delete_product(product_id: str, model_no: Optional[str] = None, user: dict = Depends(require_role("admin"))):
    try:
        db = inventory_manager(product_id=product_id)
        if model_no is not None:
            existing = db.get_data(collection_name=INVENTORY_COLLECTION, query={"product_id": product_id, "model_no": model_no})
            if not existing:
                raise HTTPException(status_code=404, detail="product not found")
            db.delete_data(collection_name=INVENTORY_COLLECTION, query={"_id": ObjectId(existing[0]["_id"])})
        else:
            db.delete(collection_name=INVENTORY_COLLECTION)
        logging.info(f"product was deleted successfully from the inventory {product_id}")
        return {"message": "product deletion was successful", "product_id": product_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("product deletion was failed!")
        raise HTTPException(status_code=500, detail="product cannot be deleted")


@app.post("/inventory/repair/{product_id}")
async def repair_damaged_product(product_id: str, model_no: Optional[str] = None, user: dict = Depends(require_role("admin", "employee"))):
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
        match_query = {"product_id": product_id, "product_type": "damaged"}
        if model_no is not None:
            match_query["model_no"] = model_no
        existing = db.get_data(collection_name=INVENTORY_COLLECTION, query=match_query)
        if not existing:
            raise HTTPException(status_code=404, detail="damaged product not found")
        item = existing[0]

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
            )
            db.update(collection_name=INVENTORY_COLLECTION, query={"_id": ObjectId(item["_id"])},
                      update_values={"damage_status": "Sent for Repair (Inhouse Warranty)"})
            logging.info(f"damaged product {product_id} sent for in-house repair, service {svc.service_id} created")
            return {"message": "sent for in-house warranty repair", "mode": "product", "service_id": svc.service_id}
        else:
            db.update(collection_name=INVENTORY_COLLECTION, query={"_id": ObjectId(item["_id"])},
                      update_values={"damage_status": "Send to Parent Company"})
            logging.info(f"damaged part {product_id} marked to send to parent company")
            return {"message": "marked to send to parent company", "mode": "part"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("repair action on damaged product failed!")
        raise HTTPException(status_code=500, detail="repair action failed")


@app.get("/customer/")
async def customers(user: dict = Depends(get_current_user)):
    try:
        db = customer_manager()
        if user["role"] in ("admin", "employee"):
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
async def search_customer(term: str = "", user: dict = Depends(get_current_user)):
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
async def create_customer(request: CustomerRequest, user: dict = Depends(require_role("admin", "employee", "distributor"))):
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
async def update_customer(customer_id: str, request: CustomerUpdateRequest, user: dict = Depends(require_role("admin", "employee"))):
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


@app.post("/customer/delete/{customer_id}")
async def delete_customer(customer_id: str, user: dict = Depends(require_role("admin"))):
    try:
        db = customer_manager()
        db.delete(collection_name=CUSTOMER_COLLECTION, query={"customer_id": customer_id})
        logging.info(f"customer was deleted successfully {customer_id}")
        return {"message": "customer deletion was successful", "customer_id": customer_id}
    except Exception as e:
        logging.error("customer deletion was failed!")
        raise HTTPException(status_code=500, detail="customer cannot be deleted")


@app.get("/salesperson/search")
async def search_salesperson(term: str = "", user: dict = Depends(get_current_user)):
    try:
        db = sales_person_manager()
        dataset = db.search(collection_name=SALESPERSON_COLLECTION, term=term) if term else db.get_data(SALESPERSON_COLLECTION, query={})
        return {"message": "sales person search results", "dataset": dataset}
    except Exception as e:
        logging.error("sales person search failed")
        raise HTTPException(status_code=500, detail="sales person search failed")


@app.post("/salesperson/create")
async def create_salesperson(request: SalesPersonRequest, user: dict = Depends(require_role("admin", "employee"))):
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
async def active_services(user: dict = Depends(get_current_user)):
    try:
        db = service_detail()
        dataset = db.get_service_data(collection_name=SERVICE_COLLECTION,
                                       query={"status": {"$in": ["active", "in_progress"]}})
        return {"message": "active services", "dataset": dataset}
    except Exception as e:
        logging.error("fetching active services failed")
        raise HTTPException(status_code=500, detail="active services cannot be fetched")


@app.get("/service/available_hologram_parts")
async def available_hologram_parts(user: dict = Depends(require_role("admin", "employee"))):
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
async def allocations(user: dict = Depends(get_current_user)):
    try:
        purge_stale_damage_images()
        db = allocation_manager()
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION, query={})
        return {"message": "allocation dataset", "dataset": dataset}
    except Exception as e:
        logging.error("fetching allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


@app.post("/allocation/report_damage/{allocation_id}")
async def report_damage(allocation_id: str, request: DamageReportRequest, user: dict = Depends(require_role("admin", "employee", "distributor"))):
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


@app.get("/allocation/mine")
async def my_allocations(user: dict = Depends(require_role("distributor"))):
    try:
        db = allocation_manager()
        dataset = db.get_data(collection_name=ALLOCATION_COLLECTION,
                               query={"allocation_type": "demo_unit", "allocated_by": user["username"]})
        return {"message": "my demo unit allocations", "dataset": dataset}
    except Exception as e:
        logging.error("fetching my allocations failed")
        raise HTTPException(status_code=500, detail="allocation dataset cannot be fetched")


def _fulfill_demo_unit(customer_id: str, customer: dict, items: list, allocated_by: str):
    """Resolves/creates the customer, deducts stock + serials from inventory, and records
    the demo_unit allocation. Shared by the direct admin/employee endpoint and by
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
    for item in items:
        available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item["product_id"])
        if available < item["quantity"]:
            raise HTTPException(status_code=400, detail=f"insufficient stock for {item['product_name']}: only {available} available")

    demo_items = []
    for item in items:
        allocated_serials = inventory_db.allocate_serials(
            collection_name=INVENTORY_COLLECTION, product_id=item["product_id"], quantity=item["quantity"]
        )
        demo_items.append({
            "product_id": item["product_id"],
            "product_name": item["product_name"],
            "quantity": item["quantity"],
            "serial_numbers": allocated_serials
        })

    allocation = allocation_manager(customer=customer_snapshot, items=demo_items, allocated_by=allocated_by)
    allocation.add(collection_name=ALLOCATION_COLLECTION)
    logging.info(f"demo unit allocation {allocation.allocation_id} created for {allocated_by}")
    return allocation.allocation_id


@app.post("/allocation/create_demo")
async def create_demo_unit_allocation(request: CreateDemoUnitRequest, user: dict = Depends(require_role("admin", "employee"))):
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
    customer_id: str = ""
    customer: dict = {}
    items: list[AllocationItem]


class ServiceRequestModel(BaseModel):
    product_id: str
    serial_no: str
    purchase_date: str
    issue: str
    image: str = ""
    video: str = ""
    location: str = "indoor"
    spare_parts: str = ""


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


@app.post("/request/demo_unit")
async def raise_demo_unit_request(request: DemoUnitRequestModel, user: dict = Depends(require_role("distributor"))):
    try:
        if not request.items:
            raise HTTPException(status_code=400, detail="add at least one product")
        if not request.customer_id and not request.customer.get("company_name"):
            raise HTTPException(status_code=400, detail="customer details are required")

        req = request_manager(
            request_type="demo_unit",
            raised_by=user["username"],
            details={
                "customer_id": request.customer_id,
                "customer": request.customer,
                "items": [item.dict() for item in request.items]
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "request raised successfully, waiting for admin/employee approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising demo unit request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.post("/request/order")
async def raise_order_request(request: OrderRequestModel, user: dict = Depends(require_role("distributor"))):
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
        return {"message": "request sent, waiting for admin/employee approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising order request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.post("/request/service")
async def raise_service_request(request: ServiceRequestModel, user: dict = Depends(require_role("technician", "distributor"))):
    try:
        req = request_manager(
            request_type="service",
            raised_by=user["username"],
            details={
                "product_id": request.product_id,
                "serial_no": request.serial_no,
                "purchase_date": request.purchase_date,
                "issue": request.issue,
                "image": request.image,
                "video": request.video,
                "location": request.location,
                "spare_parts": request.spare_parts
            }
        )
        req.add(collection_name=REQUESTS_COLLECTION)
        return {"message": "service request sent, waiting for admin/employee approval", "request_id": req.request_id}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("raising service request failed!")
        raise HTTPException(status_code=500, detail="request could not be raised")


@app.get("/request/")
async def all_requests(user: dict = Depends(require_role("admin", "employee"))):
    try:
        db = request_manager()
        dataset = db.get_data(collection_name=REQUESTS_COLLECTION, query={})
        return {"message": "requests", "dataset": dataset}
    except Exception as e:
        logging.error("fetching requests failed")
        raise HTTPException(status_code=500, detail="requests cannot be fetched")


@app.get("/request/mine")
async def my_requests(user: dict = Depends(get_current_user)):
    try:
        db = request_manager()
        dataset = db.get_data(collection_name=REQUESTS_COLLECTION, query={"raised_by": user["username"]})
        return {"message": "my requests", "dataset": dataset}
    except Exception as e:
        logging.error("fetching my requests failed")
        raise HTTPException(status_code=500, detail="requests cannot be fetched")


@app.post("/request/approve/{request_id}")
async def approve_request(request_id: str, user: dict = Depends(require_role("admin", "employee"))):
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
            allocation_id = _fulfill_demo_unit(
                customer_id=details.get("customer_id", ""),
                customer=details.get("customer", {}),
                items=details.get("items", []),
                allocated_by=req["raised_by"]
            )
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and demo unit allotted", "allocation_id": allocation_id}

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
                spare_parts=details.get("spare_parts", "")
            )
            if details.get("video"):
                _raise_media_review_request(service.service_id, user["username"])
            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and service created", "service_id": service.service_id}

        # media_review: approving means admin/employee confirmed they downloaded the
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

        # status_update: technician-raised status change, applied only on admin/employee approval
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

        # spare_part requests: approving now also issues the part — creates a
        # spare-part allocation automatically so it shows up on the Dispatch page
        if req["request_type"] == "spare_part":
            details = req["details"]
            alloc = allocation_manager(
                sales_person={},
                items=[],
                spare_part={
                    "service_id": details.get("service_id"),
                    "part_name": details.get("note", "Spare part"),
                    "quantity": 1
                },
                company_name="",
                address=""
            )
            alloc.add(collection_name=ALLOCATION_COLLECTION)

            db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                           status="approved", resolved_by=user["username"])
            return {"message": "request approved and spare part issued", "allocation_id": alloc.allocation_id}

        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                       status="approved", resolved_by=user["username"])
        return {"message": "request approved"}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"approving request failed! {e}")
        raise HTTPException(status_code=500, detail=f"request could not be approved: {e}")


@app.post("/request/reject/{request_id}")
async def reject_request(request_id: str, request: RequestRejectModel, user: dict = Depends(require_role("admin", "employee"))):
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

        db.set_status(collection_name=REQUESTS_COLLECTION, request_id=request_id,
                       status="rejected", resolved_by=user["username"], reason=request.reason)
        return {"message": "request rejected"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error("rejecting request failed!")
        raise HTTPException(status_code=500, detail="request could not be rejected")


@app.post("/allocation/create")
async def create_allocation(request: CreateAllocationRequest, user: dict = Depends(require_role("admin", "employee"))):
    try:
        if not request.items and not request.spare_part:
            raise HTTPException(status_code=400, detail="add at least one product or a spare part")

        sales_person_snapshot = {}
        if request.items:
            sp_db = sales_person_manager()
            if request.sales_person_id:
                existing = sp_db.get_data(SALESPERSON_COLLECTION, query={"sales_person_id": request.sales_person_id})
                if not existing:
                    raise HTTPException(status_code=404, detail="selected sales person not found")
                sales_person_snapshot = {k: v for k, v in existing[0].items() if k != "_id"}
            else:
                if not request.sales_person.get("name"):
                    raise HTTPException(status_code=400, detail="sales person details are required")
                new_sp = sales_person_manager(
                    name=request.sales_person.get("name"),
                    company_name=request.sales_person.get("company_name"),
                    address=request.sales_person.get("address"),
                    contact_number=request.sales_person.get("contact_number"),
                    email=request.sales_person.get("email"),
                )
                new_sp.add(collection_name=SALESPERSON_COLLECTION)
                sales_person_snapshot = {
                    "sales_person_id": new_sp.sales_person_id,
                    "name": new_sp.name,
                    "company_name": new_sp.company_name,
                    "address": new_sp.address,
                    "contact_number": new_sp.contact_number,
                    "email": new_sp.email,
                }

        inventory_db = inventory_manager()
        for item in request.items:
            available = inventory_db.get_available_quantity(INVENTORY_COLLECTION, item.product_id)
            if available < item.quantity:
                raise HTTPException(status_code=400, detail=f"insufficient stock for {item.product_name}: only {available} available")

        # No more partial returns: every allocated unit becomes its own
        # allocation document (quantity=1, one serial number each) instead of
        # bundling the whole quantity into a single row. A cart of ProductA x2
        # therefore creates two separate rows on the Allocated page, each
        # independently returnable.
        created_allocation_ids = []
        for item in request.items:
            allocated_serials = inventory_db.allocate_serials(
                collection_name=INVENTORY_COLLECTION,
                product_id=item.product_id,
                quantity=item.quantity
            )
            for serial in allocated_serials:
                unit_allocation = allocation_manager(
                    sales_person=sales_person_snapshot,
                    items=[{
                        "product_id": item.product_id,
                        "product_name": item.product_name,
                        "quantity": 1,
                        "serial_numbers": [serial]
                    }],
                    company_name=request.company_name,
                    address=request.address
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

            svc_db.update_data(
                collection_name=SERVICE_COLLECTION,
                query={"service_id": request.spare_part.service_id},
                update_values={"spare_parts_requested": request.spare_part.part_name}
            )
            spare_part_dict = request.spare_part.dict()
            redirect_to = "service.html"

            spare_allocation = allocation_manager(
                spare_part=spare_part_dict,
                company_name=request.company_name,
                address=request.address
            )
            spare_allocation.add(collection_name=ALLOCATION_COLLECTION)
            created_allocation_ids.append(spare_allocation.allocation_id)

        logging.info(f"allocation(s) created successfully: {created_allocation_ids}")
        return {"message": "allocation created successfully", "allocation_ids": created_allocation_ids, "redirect": redirect_to}

    except HTTPException:
        raise
    except Exception as e:
        logging.error("allocation creation failed!")
        raise HTTPException(status_code=500, detail="allocation creation failed")


@app.post("/allocation/return/{allocation_id}")
async def return_allocation(allocation_id: str, user: dict = Depends(require_role("admin", "employee", "distributor"))):
    """
    Every allocation — product or spare part — now returns in one shot.
    Partial returns were removed: since each product allocation document
    represents a single allocated unit (quantity=1, one serial number),
    there's nothing left to split — the row is either returned or it isn't.

    If a damage report was filed on this allocation before it's returned,
    the returned item(s) are also filed into inventory as "damaged" product
    entries (kept non-fatal - a hiccup here doesn't roll back the return).
    """
    try:
        db = allocation_manager()
        matches = db.get_data(collection_name=ALLOCATION_COLLECTION, query={"allocation_id": allocation_id})
        if not matches:
            raise HTTPException(status_code=404, detail="allocation not found")
        allocation = matches[0]

        if allocation.get("return_status") == "returned":
            raise HTTPException(status_code=400, detail="this allocation is already returned")

        db.update_data(
            collection_name=ALLOCATION_COLLECTION,
            query={"allocation_id": allocation_id},
            update_values={
                "return_status": "returned",
                "return_completed_at": datetime.now(timezone.utc).isoformat(),
                "returned_by": user["username"]
            }
        )
        logging.info(f"allocation {allocation_id} marked as returned")

        damage_report = allocation.get("damage_report") or {}
        if damage_report.get("reported"):
            try:
                inv_db = inventory_manager()
                today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                reason = f"returned damaged from allocation {allocation_id}"
                if damage_report.get("issue"):
                    reason += f" — {damage_report['issue']}"

                if allocation.get("allocation_type") == "spare_part":
                    sp = allocation.get("spare_part", {})
                    part_name = sp.get("part_name", "")
                    qty = sp.get("quantity", 0) or 0
                    if part_name and qty > 0:
                        inventory_manager(
                            product_name=part_name,
                            product_id=f"DMG-{uuid.uuid4().hex[:8].upper()}",
                            quantity=qty,
                            purchase_date=today,
                            product_type="damaged",
                            reason=reason,
                        ).add(collection_name=INVENTORY_COLLECTION)
                else:
                    for item in allocation.get("items", []):
                        product_name = item.get("product_name", "")
                        qty = item.get("quantity", 0) or 0
                        if not product_name or qty <= 0:
                            continue
                        product_id = item.get("product_id") or f"DMG-{uuid.uuid4().hex[:8].upper()}"
                        inventory_manager(
                            product_name=product_name,
                            product_id=product_id,
                            quantity=qty,
                            purchase_date=today,
                            serial_numbers=item.get("serial_numbers", []) or [],
                            product_type="damaged",
                            reason=reason,
                        ).add(collection_name=INVENTORY_COLLECTION)

                logging.info(f"allocation {allocation_id}'s damaged item(s) filed into inventory as damaged product")
            except Exception as inv_err:
                logging.error(f"allocation {allocation_id} returned but filing damaged item(s) into inventory failed: {inv_err}")

        return {"message": "allocation marked as returned", "allocation_id": allocation_id}

    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"marking allocation as returned failed! {e}")
        raise HTTPException(status_code=500, detail="allocation cannot be marked as returned")


app.mount("/css", StaticFiles(directory=os.path.join(BASE_DIR, "css")), name="css")
app.mount("/images", StaticFiles(directory=os.path.join(BASE_DIR, "images")), name="images")
app.mount("/pages", StaticFiles(directory=os.path.join(BASE_DIR, "pages"), html=True), name="pages")

app.mount("/", StaticFiles(directory=BASE_DIR, html=True), name="root")