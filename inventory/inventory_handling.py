from mongo.mongodb_connection import mongodbclient
from logger import logging


class inventory_manager(mongodbclient):

    def __init__(self, product_name=None, product_id=None, quantity=None,
                 purchase_date=None, lot_no=None, supplier=None, price=None, tax_rate=None):

        super().__init__()

        self.product_name = product_name
        self.product_id = product_id
        self.lot_no = lot_no
        self.supplier = supplier
        self.price = price
        self.tax_rate = tax_rate
        self.purchase_date = purchase_date
        self.quantity = quantity

    def add(self, collection_name):
        try:
            product_dic = {
                "product_name": self.product_name,
                "product_id": self.product_id,
                "lot_no": self.lot_no,
                "supplier": self.supplier,
                "price": self.price,
                "tax_rate": self.tax_rate,
                "purchase_date": self.purchase_date,
                "quantity": self.quantity
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
            # pehle quantity nikal lo, delete karne se PEHLE (warna document mil hi nahi payega)
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
