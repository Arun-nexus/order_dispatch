from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone
import uuid


class order_manager(mongodbclient):

    def __init__(self, customer=None, items=None, payment_mode=None, payment_details=None, discount=0, creator=None, warranty_years=1, warranty_charge=0):
        """
        customer: dict -> {customer_id, company_name, company_address, gst_number,
                            contractor_person, contractor_number, contractor_email}
        items: list of dicts -> {product_id, product_name, serial_no, quantity, price, tax_rate}
        creator: dict -> who created this order, one of:
            direct order  -> {"type": "direct", "created_by": "<username>"}
            approved req  -> {"type": "request", "raised_by": "<distributor>", "approved_by": "<admin/employee>"}
        payment_details: dict, shape depends on payment_mode
            Credit       -> {"credit_days": int}
            Cheque       -> {"cheque_number": str, "cheque_date": str, "bank_name": str}
            DemandDraft  -> {"dd_number": str, "dd_date": str, "bank_name": str}
            UPI/Cash/NetBanking -> {}
        warranty_years: int -> standard warranty is 1 year; > 1 means extended
        warranty_charge: float -> additional charge for the extended warranty (0 for standard)
        """

        super().__init__()

        self.order_id = str(uuid.uuid4())
        self.customer = customer or {}
        self.items = items or []
        self.payment_mode = payment_mode
        self.payment_details = payment_details or {}
        self.status = "placed"
        self.discount = discount
        self.creator = creator or {}
        self.warranty_years = warranty_years or 1
        self.warranty_charge = warranty_charge or 0

    def add(self, collection_name):
        try:
            if not self.items:
                raise Exception("order must contain at least one product")

            subtotal = 0.0
            tax_total = 0.0

            for item in self.items:
                quantity = item.get("quantity", 0)
                price = item.get("price", 0)
                tax_rate = item.get("tax_rate", 0)

                line_amount = price * quantity
                line_tax = line_amount * tax_rate / 100

                item["line_amount"] = line_amount
                item["line_tax"] = line_tax
                item["line_total"] = line_amount + line_tax

                subtotal += line_amount
                tax_total += line_tax

            total_mrp = subtotal + tax_total - self.discount + self.warranty_charge

            order_dict = {
                "order_id": self.order_id,
                "customer": self.customer,
                "items": self.items,
                "payment_mode": self.payment_mode,
                "payment_details": self.payment_details,
                "status": self.status,
                "subtotal": subtotal,
                "tax_total": tax_total,
                "discount": self.discount,
                "warranty_years": self.warranty_years,
                "warranty_charge": self.warranty_charge,
                "total_mrp": total_mrp,
                "creator": self.creator,
                "order_date": datetime.now(timezone.utc).isoformat()
            }
            result = super().add(collection_name=collection_name, dictionary=order_dict)
            return result

        except Exception as e:
            logging.error("adding order failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name, query, projection)
            return dataset
        except Exception as e:
            logging.error("data fetching was failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            deleted_order = super().delete_data(collection_name=collection_name, query=query, many=many)
            return deleted_order
        except Exception as e:
            logging.error("order deletion was not successful")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            updated_data = super().update_data(collection_name=collection_name, query=query, update_values=update_values, many=many)
            return updated_data
        except Exception as e:
            logging.error("data updation was failed!")
            raise Exception(e)

    def delivery_confirmation(self, collection_name, order_id):
        try:
            result = self.update(collection_name=collection_name, query={"order_id": order_id}, update_values={"status": "delivered"})
            logging.info(f"order {order_id} marked as delivered")
            return result
        except Exception as e:
            logging.error("delivery confirmation failed!")
            raise Exception(e)

    def order_tracking(self, collection_name: str, order_id):
        try:
            dataset = self.get_data(collection_name=collection_name, query={"order_id": order_id})
            if not dataset:
                raise Exception(f"no order found with id {order_id}")
            return dataset[0]
        except Exception as e:
            logging.error("order tracking failed!")
            raise Exception(e)