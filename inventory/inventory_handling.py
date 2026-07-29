from mongodb.mongodb_connection import mongodbclient
from logger import logging
from bson import ObjectId


class inventory_manager(mongodbclient):

    def __init__(self, product_name=None, product_id=None, quantity=None,
                 purchase_date=None, lot_no=None, supplier=None, price=None, tax_rate=None,
                 model_no=None, supplier_address=None, serial_numbers=None):

        super().__init__()

        self.product_name = product_name
        self.product_id = product_id
        self.lot_no = lot_no
        self.supplier = supplier
        self.price = price
        self.tax_rate = tax_rate
        self.purchase_date = purchase_date
        self.quantity = quantity
        self.model_no = model_no
        self.supplier_address = supplier_address
        self.serial_numbers = serial_numbers or []

    def add(self, collection_name):
        try:
            product_dic = {
                "product_name": self.product_name,
                "product_id": self.product_id,
                "lot_no": self.lot_no,
                "supplier": self.supplier,
                "supplier_address": self.supplier_address,
                "price": self.price,
                "tax_rate": self.tax_rate,
                "purchase_date": self.purchase_date,
                "quantity": self.quantity,
                "model_no": self.model_no,
                "serial_numbers": self.serial_numbers
            }
            product = super().add(collection_name=collection_name, dictionary=product_dic)
            logging.info("product added successfully")
            return product
        except Exception as e:
            logging.error("adding product to inventory was failed!")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            data = super().update_data(collection_name=collection_name, query=query,
                                         update_values=update_values, many=many)
            logging.info("value was updated to the inventory!")
            return data
        except Exception as e:
            logging.error("data updation unsuccessful")
            raise Exception(e)

    def get_data(self, collection_name, query=None, projection=None):
        try:
            dataset = super().get_data(collection_name=collection_name, query=query, projection=projection)
            logging.info("inventory data was fetched successfully")
            return dataset
        except Exception as e:
            logging.error("inventory dataset cannot be fetched!")
            raise Exception(e)

    def delete(self, collection_name):
        try:
            existing = self.get_data(collection_name=collection_name, query={"product_id": self.product_id})
            if not existing:
                raise Exception(f"no product found with id {self.product_id}")

            deleted = super().delete_data(collection_name=collection_name,
                                            query={"product_id": self.product_id})
            logging.info("product was successfully deleted from inventory")
            return deleted
        except Exception as e:
            logging.error("product deletion was unsuccessful")
            raise Exception(e)

    def get_available_quantity(self, collection_name, product_id):
        try:
            entries = self.get_data(collection_name=collection_name, query={"product_id": product_id})
            return sum(int(e.get("quantity", 0) or 0) for e in entries)
        except Exception as e:
            logging.error("checking available quantity failed!")
            raise Exception(e)

    def allocate_serials(self, collection_name, product_id, quantity):
        """
        Pulls `quantity` serial numbers out of inventory for product_id (oldest lots first),
        decrementing each lot's quantity and removing the used serials. Returns the list of
        serial numbers allocated. Raises if stock is insufficient.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query={"product_id": product_id, "quantity": {"$gt": 0}}
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            remaining = quantity
            allocated = []

            for entry in entries:
                if remaining <= 0:
                    break

                available_serials = entry.get("serial_numbers") or []
                take = min(remaining, len(available_serials), int(entry.get("quantity", 0) or 0))
                if take <= 0:
                    continue

                taken_serials = available_serials[:take]
                leftover_serials = available_serials[take:]
                new_quantity = int(entry.get("quantity", 0) or 0) - take

                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": leftover_serials, "quantity": new_quantity}
                )

                allocated.extend(taken_serials)
                remaining -= take

            if remaining > 0:
                raise Exception(f"insufficient stock for product {product_id}, short by {remaining}")

            logging.info(f"allocated {len(allocated)} serials for product {product_id}")
            return allocated

        except Exception as e:
            logging.error("serial allocation failed!")
            raise Exception(e)