import os
from mongodb.mongodb_connection import mongodbclient

OLD_COLLECTION = "inventory"
NEW_COLLECTION = "inventory_fixed"


def main():
    db = mongodbclient()

    old_docs = db.get_data(OLD_COLLECTION)
    print(f"fetched {len(old_docs)} documents from '{OLD_COLLECTION}'")

    existing_new = db.get_data(NEW_COLLECTION)
    if existing_new:
        db.delete_data(NEW_COLLECTION, query={}, many=True)

    inserted = 0
    for doc in old_docs:
        doc.pop("_id", None)

        product_id = doc.get("product_id")
        model_no = doc.get("model_no")
        doc["product_id"] = model_no
        doc["model_no"] = product_id

        db.add(NEW_COLLECTION, doc)
        inserted += 1

    print(f"inserted {inserted} documents into '{NEW_COLLECTION}'")
    print(f"verify the data, then drop '{OLD_COLLECTION}' and rename '{NEW_COLLECTION}' to '{OLD_COLLECTION}'")


if __name__ == "__main__":
    main()