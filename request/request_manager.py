from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timezone
import uuid


class request_manager(mongodbclient):

    def __init__(self, request_type=None, raised_by=None, details=None):
        """
        request_type: 'demo_unit' (distributor asking for products for a customer)
                    | 'spare_part' (technician asking for a spare part for a service)
        raised_by: username of whoever raised it
        details: dict, shape depends on request_type
            demo_unit  -> {customer_id, customer, items}
            spare_part -> {service_id, note}
        """
        super().__init__()

        self.request_id = str(uuid.uuid4())
        self.request_type = request_type
        self.raised_by = raised_by
        self.details = details or {}
        self.status = "pending"

    def add(self, collection_name):
        try:
            request_dict = {
                "request_id": self.request_id,
                "request_type": self.request_type,
                "raised_by": self.raised_by,
                "details": self.details,
                "status": self.status,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "resolved_by": None,
                "resolved_at": None,
                "reason": ""
            }
            result = super().add(collection_name=collection_name, dictionary=request_dict)
            logging.info("request raised successfully")
            return result
        except Exception as e:
            logging.error("raising request failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            return super().get_data(collection_name, query, projection)
        except Exception as e:
            logging.error("request data fetching failed!")
            raise Exception(e)

    def set_status(self, collection_name, request_id, status, resolved_by=None, reason=""):
        try:
            update_values = {
                "status": status,
                "resolved_by": resolved_by,
                "resolved_at": datetime.now(timezone.utc).isoformat(),
                "reason": reason
            }
            result = super().update_data(collection_name=collection_name,
                                          query={"request_id": request_id},
                                          update_values=update_values)
            logging.info(f"request {request_id} marked as {status}")
            return result
        except Exception as e:
            logging.error("updating request status failed!")
            raise Exception(e)