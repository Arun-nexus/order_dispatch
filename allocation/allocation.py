from mongodb.mongodb_connection import mongodbclient
from logger import logging
from datetime import datetime, timedelta, timezone
import uuid


class allocation_manager(mongodbclient):

    RETURN_WINDOW_DAYS = 7

    def __init__(self, distributor=None, items=None, spare_part=None, company_name=None, address=None,
                 customer=None, allocated_by=None):
        """
        distributor: dict snapshot -> {distributor_id, name, company_name, address, contact_number, email}
                       (used for allocation_type='product': admin/employee allotting stock to a distributor)
        items: list of dicts -> {product_id, product_name, quantity, serial_numbers}
        spare_part: dict -> {service_id, part_name, quantity} (allocation_type='spare_part')
        customer: dict snapshot -> {customer_id, company_name, ...} (allocation_type='demo_unit': a
                  distributor allotting a demo unit to a customer)
        allocated_by: username of the distributor who created a demo_unit allocation
        """
        super().__init__()

        self.allocation_id = str(uuid.uuid4())
        self.distributor = distributor or {}
        self.items = items or []
        self.spare_part = spare_part or {}
        self.customer = customer or {}
        self.allocated_by = allocated_by
        self.company_name = company_name
        self.address = address
        self.allotment_date = datetime.now(timezone.utc)
        self.return_due_date = self.allotment_date + timedelta(days=self.RETURN_WINDOW_DAYS)
        self.return_status = "pending"

    def add(self, collection_name):
        try:
            if not self.items and not self.spare_part:
                raise Exception("allocation must contain at least one product or a spare part")

            if self.spare_part:
                allocation_type = "spare_part"
            elif self.customer:
                allocation_type = "demo_unit"
            else:
                allocation_type = "product"

            allocation_dict = {
                "allocation_id": self.allocation_id,
                "allocation_type": allocation_type,
                "distributor": self.distributor,
                "customer": self.customer,
                "allocated_by": self.allocated_by,
                "items": self.items,
                "spare_part": self.spare_part,
                "company_name": self.company_name,
                "address": self.address,
                "allotment_date": self.allotment_date.isoformat(),
                "return_due_date": self.return_due_date.isoformat(),
                "return_status": self.return_status
            }
            result = super().add(collection_name=collection_name, dictionary=allocation_dict)
            logging.info("allocation created successfully")
            return result
        except Exception as e:
            logging.error("allocation creation failed!")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            return super().get_data(collection_name, query, projection)
        except Exception as e:
            logging.error("allocation data fetching failed!")
            raise Exception(e)

    def mark_returned(self, collection_name, allocation_id):
        try:
            result = super().update_data(collection_name=collection_name,
                                          query={"allocation_id": allocation_id},
                                          update_values={"return_status": "returned",
                                                          "returned_on": datetime.now(timezone.utc).isoformat()})
            logging.info(f"allocation {allocation_id} marked as returned")
            return result
        except Exception as e:
            logging.error("marking allocation as returned failed!")
            raise Exception(e)

    def delete(self, collection_name, query, many=False):
        try:
            return super().delete_data(collection_name=collection_name, query=query, many=many)
        except Exception as e:
            logging.error("allocation deletion failed!")
            raise Exception(e)