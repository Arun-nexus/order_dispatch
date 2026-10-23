from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone
import uuid
from datetime import timedelta

PAYMENT_MODES = ("paid", "partial", "credit")


def compute_payment(mode, total, paid_amount=0, credit_days=0, base_date=None):
    """
    Normalises a payment choice into the fields stored on a shipment / purchase:
      paid    -> everything paid now, no due date
      partial -> `paid_amount` paid now, the rest is on credit for `credit_days`
      credit  -> nothing paid now, everything on credit for `credit_days`
    due_date = base_date (YYYY-MM-DD) + credit_days. `total` and `paid_amount`
    must be in the same currency.
    """
    mode = (mode or "paid").strip().lower()
    if mode not in PAYMENT_MODES:
        mode = "paid"
    total = round(float(total or 0), 2)
    if mode == "paid":
        return {"payment_mode": "paid", "paid_amount": total, "credit_days": 0, "due_date": None}
    paid = 0.0 if mode == "credit" else round(min(max(float(paid_amount or 0), 0.0), total), 2)
    days = max(int(credit_days or 0), 0)
    try:
        base = datetime.strptime((base_date or "")[:10], "%Y-%m-%d")
    except ValueError:
        base = datetime.now(timezone.utc).replace(tzinfo=None)
    due = (base + timedelta(days=days)).strftime("%Y-%m-%d") if days else None
    return {"payment_mode": mode, "paid_amount": paid, "credit_days": days, "due_date": due}


class shipment_manager(mongodbclient):

    def __init__(self, company_name=None, company_address=None, dispatch_date=None,
                 received_date=None, products=None, created_by=None,
                 customer_id=None, payment_mode="paid", currency="INR", exchange_rate=1,
                 paid_amount=0, credit_days=0, invoice_no=""):
        """
        company_name / company_address: destination company details
        dispatch_date: str (YYYY-MM-DD) -> required, when the shipment left
        received_date: str (YYYY-MM-DD) -> optional, can be filled in later
                        via mark_received() once the company confirms receipt
        products: list of dicts, one per product in the shipment ->
            {
                "product_name": str,
                "quantity": int,
                "price": float,
                "warranty": str,                      # e.g. "12 months", optional
                "parts": [{"part_name": str, "quantity": int}, ...]   # optional
            }
        created_by: str -> username of the admin/employee who logged the shipment
        """

        super().__init__()

        self.shipment_id = str(uuid.uuid4())
        self.company_name = company_name
        self.company_address = company_address or ""
        self.invoice_no = (invoice_no or "").strip()
        self.dispatch_date = dispatch_date
        self.received_date = received_date or None
        self.products = products or []
        self.created_by = created_by
        self.customer_id = customer_id or ""
        self.payment_mode = payment_mode if payment_mode in PAYMENT_MODES else "paid"
        self.paid_amount = float(paid_amount or 0)
        self.credit_days = int(credit_days or 0)
        self.currency = (currency or "INR").upper()
        self.exchange_rate = float(exchange_rate or 1) if self.currency != "INR" else 1.0

    @staticmethod
    def _normalize_products(products):
        """
        Fills in safe defaults so every product/part always has the same
        shape in the database, regardless of what the client omitted.
        Also computes each product's line_total (price * quantity) so
        reports/cards don't need to recompute it every time.
        """
        normalized = []
        for product in products:
            quantity = product.get("quantity", 0) or 0
            price = product.get("price", 0) or 0

            parts = []
            for part in product.get("parts", []) or []:
                part_name = (part.get("part_name") or "").strip()
                if not part_name:
                    continue
                status = part.get("status", "assembly")
                if status not in ("assembly", "purchase", "warranty"):
                    status = "assembly"
                parts.append({
                    "part_name": part_name,
                    "quantity": part.get("quantity", 0) or 0,
                    "status": status,
                })

            normalized.append({
                "product_name": product.get("product_name", ""),
                "quantity": quantity,
                "price": price,
                "line_total": price * quantity,
                "warranty": product.get("warranty", "") or "",
                "parts": parts,
            })
        return normalized

    def add(self, collection_name):
        try:
            if not self.company_name:
                raise Exception("shipment must have a company name")
            if not self.dispatch_date:
                raise Exception("shipment must have a dispatch date")
            if not self.products:
                raise Exception("shipment must contain at least one product")

            products = self._normalize_products(self.products)
            if not any(p["product_name"] for p in products):
                raise Exception("every product must have a name")

            total_amount = sum(p["line_total"] for p in products)
            pay = compute_payment(self.payment_mode, total_amount, self.paid_amount, self.credit_days, self.dispatch_date)
            shipment_dict = {
                "shipment_id": self.shipment_id,
                "company_name": self.company_name,
                "company_address": self.company_address,
                "invoice_no": self.invoice_no,
                "dispatch_date": self.dispatch_date,
                "received_date": self.received_date,          # None until marked received
                "status": "received" if self.received_date else "pending",
                "products": products,
                "created_by": self.created_by,
                "customer_id": self.customer_id,
                "payment_mode": pay["payment_mode"],
                "paid_amount": pay["paid_amount"],          # in the shipment's own currency
                "credit_days": pay["credit_days"],
                "due_date": pay["due_date"],
                "currency": self.currency,
                "exchange_rate": self.exchange_rate,
                "total_amount": total_amount,
                "total_inr": round(total_amount * self.exchange_rate, 2),
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            result = super().add(collection_name=collection_name, dictionary=shipment_dict)
            return result, self.shipment_id

        except Exception as e:
            logging.error("adding shipment failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name, query, projection)
            return dataset
        except Exception as e:
            logging.error("shipment data fetching was failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            deleted_shipment = super().delete_data(collection_name=collection_name, query=query, many=many)
            return deleted_shipment
        except Exception as e:
            logging.error("shipment deletion was not successful")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            if "products" in update_values:
                update_values["products"] = self._normalize_products(update_values["products"])
            updated_data = super().update_data(collection_name=collection_name, query=query, update_values=update_values, many=many)
            return updated_data
        except Exception as e:
            logging.error("shipment updation was failed!")
            raise Exception(e)

    def mark_received(self, collection_name, shipment_id, received_date):
        try:
            result = self.update(
                collection_name=collection_name,
                query={"shipment_id": shipment_id},
                update_values={"received_date": received_date, "status": "received"},
            )
            logging.info(f"shipment {shipment_id} marked as received")
            return result
        except Exception as e:
            logging.error("marking shipment as received failed!")
            raise Exception(e)

    def consume_parts(self, collection_name, shipment_id, parts_needed):
        """
        Deducts spare-part quantities from a shipment's stock — used when an
        Assembly is built using parts sourced from this shipment.

        parts_needed: list of {"part_name": str, "quantity": int}
        Matches part_name case-insensitively across every product's parts
        list inside the shipment (parts are a shared pool for the whole
        shipment, not tied to a single product). Raises if the shipment
        doesn't have enough of a part left, so callers can roll back /
        surface a clear error instead of silently going negative.
        """
        try:
            existing = self.get_data(collection_name=collection_name, query={"shipment_id": shipment_id})
            if not existing:
                raise Exception(f"no shipment found with id {shipment_id}")
            shipment = existing[0]
            products = shipment.get("products", [])

            # how much of each part is available right now, across all products
            available = {}
            for product in products:
                for part in product.get("parts", []):
                    key = part["part_name"].strip().lower()
                    available[key] = available.get(key, 0) + (part.get("quantity", 0) or 0)

            for need in parts_needed:
                key = (need.get("part_name") or "").strip().lower()
                qty = need.get("quantity", 0) or 0
                if qty <= 0:
                    continue
                if available.get(key, 0) < qty:
                    raise Exception(
                        f"not enough '{need.get('part_name')}' in shipment {shipment_id} "
                        f"(need {qty}, have {available.get(key, 0)})"
                    )

            # deduct greedily across whichever product/part entries carry that name
            remaining_need = {(n.get("part_name") or "").strip().lower(): n.get("quantity", 0) or 0 for n in parts_needed}
            for product in products:
                for part in product.get("parts", []):
                    key = part["part_name"].strip().lower()
                    if remaining_need.get(key, 0) > 0:
                        take = min(part.get("quantity", 0) or 0, remaining_need[key])
                        part["quantity"] = (part.get("quantity", 0) or 0) - take
                        remaining_need[key] -= take

            self.update(collection_name=collection_name, query={"shipment_id": shipment_id}, update_values={"products": products})
            logging.info(f"parts consumed from shipment {shipment_id}: {parts_needed}")
            return True

        except Exception as e:
            logging.error("consuming parts from shipment failed!")
            raise Exception(e)

    def shipment_tracking(self, collection_name: str, shipment_id):
        try:
            dataset = self.get_data(collection_name=collection_name, query={"shipment_id": shipment_id})
            if not dataset:
                raise Exception(f"no shipment found with id {shipment_id}")
            return dataset[0]
        except Exception as e:
            logging.error("shipment tracking failed!")
            raise Exception(e)