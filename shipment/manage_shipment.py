from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone
import uuid


class shipment_manager(mongodbclient):

    def __init__(self, company_name=None, company_address=None, dispatch_date=None,
                 received_date=None, products=None, created_by=None):
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
        self.dispatch_date = dispatch_date
        self.received_date = received_date or None
        self.products = products or []
        self.created_by = created_by

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
                parts.append({
                    "part_name": part_name,
                    "quantity": part.get("quantity", 0) or 0,
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

            shipment_dict = {
                "shipment_id": self.shipment_id,
                "company_name": self.company_name,
                "company_address": self.company_address,
                "dispatch_date": self.dispatch_date,
                "received_date": self.received_date,          # None until marked received
                "status": "received" if self.received_date else "pending",
                "products": products,
                "created_by": self.created_by,
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

    def shipment_tracking(self, collection_name: str, shipment_id):
        try:
            dataset = self.get_data(collection_name=collection_name, query={"shipment_id": shipment_id})
            if not dataset:
                raise Exception(f"no shipment found with id {shipment_id}")
            return dataset[0]
        except Exception as e:
            logging.error("shipment tracking failed!")
            raise Exception(e)