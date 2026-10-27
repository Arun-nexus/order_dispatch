from mongodb.mongodb_connection import mongodbclient
from logger import logging
from bson import ObjectId
import uuid
import re


class inventory_manager(mongodbclient):

    def __init__(self, product_name=None, product_id=None, quantity=None,
                 purchase_date=None, lot_no=None, supplier=None, price=None, tax_rate=None,
                 model_no=None, supplier_address=None, serial_numbers=None, product_type=None,
                 warranty_until=None, reason="",
                 parent_product_name="", part_category=None, hologram_numbers=None,
                 created_by=None, invoice_no=""):

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
        self.invoice_no = (invoice_no or "").strip()
        self.serial_numbers = serial_numbers or []
        # "product" | "spare_parts" | "damaged" | "accessories"
        self.product_type = product_type or "product"
        # only meaningful for "damaged" entries created from a swapped-out
        # faulty part: warranty_until carries the source shipment lot's
        # warranty expiry forward (so /inventory/'s dynamic warranty_status
        # calc picks it up), and reason records why it's flagged (e.g. which
        # service/serial it was pulled from when it's already out of warranty)
        self.warranty_until = warranty_until
        self.reason = reason
        # spare_parts / service_parts only
        self.parent_product_name = parent_product_name or ""
        self.part_category = part_category or None      # service_parts: "purchase" | "warranty"
        self.hologram_numbers = list(hologram_numbers or [])
        # username of whoever raised this add/update — set on create, and
        # refreshed as updated_by whenever an existing lot is merged into
        self.created_by = created_by

    def add(self, collection_name):
        try:
            product_dic = {
                "product_name": self.product_name,
                "product_id": self.product_id,
                "lot_no": self.lot_no,
                "supplier": self.supplier,
                "supplier_address": self.supplier_address,
                "invoice_no": self.invoice_no,
                "price": self.price,
                "tax_rate": self.tax_rate,
                "purchase_date": self.purchase_date,
                "quantity": self.quantity,
                "model_no": self.model_no,
                "serial_numbers": self.serial_numbers,
                "product_type": self.product_type,
                "warranty_until": self.warranty_until,
                "reason": self.reason,
                "created_by": self.created_by,
                "updated_by": self.created_by,
            }
            if self.product_type in ("spare_parts", "service_parts"):
                product_dic["parent_product_name"] = self.parent_product_name
                product_dic["part_category"] = self.part_category
                product_dic["hologram_numbers"] = self.hologram_numbers
            product = super().add(collection_name=collection_name, dictionary=product_dic)
            logging.info("product added successfully")
            return product
        except Exception as e:
            logging.error("adding product to inventory was failed!")
            raise Exception(e)

    def add_or_merge(self, collection_name):
        """
        Used by the "Add Existing Product" restock flow. If an entry already
        exists for this exact product_name + product_id + model_no +
        product_type, the new serial numbers are appended to it and its
        quantity is increased — instead of creating a second, separate
        document for the same product (which used to make the table/eye-view
        ambiguous about which lot's quantity/serials belong to which row).
        Otherwise a fresh entry is created, same as add().

        Category-change-by-serial: if a serial number being added here is
        already on file under a *different* product_type entry anywhere in
        inventory, that unit is pulled out of its old entry (1 unit + that
        serial removed, entry kept at 0 if it hits zero) and lands in the
        product_type being added now. This is how a unit gets flagged
        faulty (product_type="damaged") when it's re-added as damaged even
        though it was previously a product/spare_parts/service_parts/
        accessories entry, and how it comes back OUT of "damaged" once it's
        re-added under its real category. The duplicate-serial guard below
        (a serial found on the exact same product_id + model_no +
        product_type) is reserved for product_type "product" only — every
        other type that flows through here (accessories, damaged) is
        allowed to reuse a serial number already on file under the same lot.
        """
        try:
            target_key = {
                "product_id": self.product_id,
                "model_no": self.model_no,
                "product_type": self.product_type,
            }

            duplicates = []
            for serial in list(self.serial_numbers):
                owners = self.get_data(collection_name=collection_name, query={"serial_numbers": serial})
                for owner in owners:
                    same_lot = (
                        owner.get("product_id") == target_key["product_id"]
                        and owner.get("model_no") == target_key["model_no"]
                        and owner.get("product_type") == target_key["product_type"]
                    )
                    if same_lot:
                        # duplicate-serial guard only ever applies to
                        # product_type "product" — accessories/damaged (the
                        # other types that flow through add_or_merge) are
                        # allowed to reuse a serial number already on file
                        # under the very same lot too.
                        if self.product_type == "product":
                            duplicates.append(serial)
                        continue

                    owner_serials = owner.get("serial_numbers") or []
                    remaining_serials = [s for s in owner_serials if s != serial]
                    new_owner_quantity = max(int(owner.get("quantity", 0) or 0) - 1, 0)
                    # keep the old entry even when it drops to 0 (never auto-deleted)
                    self.update_data(
                        collection_name=collection_name,
                        query={"_id": ObjectId(owner["_id"])},
                        update_values={"serial_numbers": remaining_serials, "quantity": new_owner_quantity}
                    )
                    logging.info(
                        f"serial {serial} moved out of '{owner.get('product_type', 'product')}' "
                        f"into '{self.product_type}'"
                    )

            if duplicates:
                raise Exception(f"serial number(s) already exist on this product: {', '.join(duplicates)}")

            existing = self.get_data(collection_name=collection_name, query=target_key)
            if existing:
                entry = existing[0]
                current_serials = entry.get("serial_numbers") or []
                merged_serials = current_serials + list(self.serial_numbers)
                new_quantity = int(entry.get("quantity", 0) or 0) + int(self.quantity or 0)

                update_values = {
                    "serial_numbers": merged_serials,
                    "quantity": new_quantity,
                    "lot_no": self.lot_no,
                    "supplier": self.supplier,
                    "supplier_address": self.supplier_address,
                    "invoice_no": self.invoice_no,
                    "price": self.price,
                    "tax_rate": self.tax_rate,
                    "purchase_date": self.purchase_date,
                    "updated_by": self.created_by,
                }
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values=update_values
                )
                logging.info(f"merged {self.quantity} unit(s) into existing '{self.product_type}' inventory entry for {self.product_id}")
                return {"mode": "merged", "product_id": self.product_id, "quantity_added": self.quantity}

            return self.add(collection_name=collection_name)

        except Exception as e:
            logging.error("adding/merging inventory entry failed!")
            raise Exception(e)

    def add_part(self, collection_name):
        """
        Manual add for spare_parts / service_parts (same shape the shipment sync creates):
        tracked by quantity, no serials, auto-generated product_id. Merges into an existing
        entry only when part name + parent product + type + category + received date +
        warranty date all match; hologram numbers (if given) are appended to it.
        """
        try:
            warranty_until = self.warranty_until or None
            match_query = {
                "product_name": self.product_name,
                "parent_product_name": self.parent_product_name,
                "product_type": self.product_type,
                "purchase_date": self.purchase_date,
                "warranty_until": warranty_until,
            }
            if self.part_category:
                match_query["part_category"] = self.part_category
            if self.invoice_no:
                match_query["invoice_no"] = self.invoice_no

            existing = self.get_data(collection_name=collection_name, query=match_query)
            if existing:
                entry = existing[0]
                holograms = list(entry.get("hologram_numbers") or []) + self.hologram_numbers
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"quantity": int(entry.get("quantity", 0) or 0) + int(self.quantity or 0),
                                   "hologram_numbers": holograms,
                                   "updated_by": self.created_by}
                )
                return {"mode": "merged", "product_id": entry.get("product_id"), "quantity_added": self.quantity}

            self.product_id = f"SP-{uuid.uuid4().hex[:8].upper()}"
            self.warranty_until = warranty_until
            self.model_no = ""
            self.serial_numbers = []
            return self.add(collection_name=collection_name)
        except Exception as e:
            logging.error("adding spare/service part failed!")
            raise Exception(e)

    def restock_returned_units(self, collection_name, product_id, product_name, model_no, quantity, serial_numbers=None):
        """
        Used when a previously allocated (undamaged) unit is returned and needs
        to go back into inventory. Adds `quantity` back onto the lot that
        matches product_id + product_name + model_no exactly — same matching
        as add_or_merge — so a returned unit of one variant is never merged
        into a different variant's stock, and appends `serial_numbers` back
        onto that lot's serial list.

        Deliberately does NOT touch lot_no/supplier/price/tax_rate/purchase_date
        the way add_or_merge does: add_or_merge is for the "Add Existing
        Product" restock flow, where the user is re-entering fresh purchase
        info for a new physical lot, so overwriting those fields is correct
        there. A return isn't a new purchase — the original lot's purchase
        metadata must be left exactly as it was.

        If the original lot document no longer exists (e.g. it was deleted
        after being fully allocated out), falls back to creating a minimal new
        entry so the returned stock isn't silently lost.
        """
        try:
            # Same pitfall already documented/handled at the inventory_detail
            # endpoint: older lots (or model-less product types) store
            # model_no as null/missing, not "". Querying a literal "" here
            # would miss those lots entirely and wrongly fall through to the
            # "create a new entry" branch below instead of merging — which
            # is exactly how a return used to end up creating a second,
            # separate inventory document instead of merging into the old
            # one. Match null/missing the same way "" is matched instead.
            query = {"product_name": product_name}   # product_id is not part of a product's identity
            if model_no:
                query["model_no"] = model_no
            else:
                query["model_no"] = {"$in": [None, ""]}
            serial_numbers = list(dict.fromkeys(s for s in (serial_numbers or []) if s))
            # An OK return should never get merged into a "damaged" lot that
            # happens to share the same product_id/name/model_no (e.g. an
            # earlier faulty return of the same product) — it belongs back
            # in the category it was actually stocked/sold under.
            query["product_type"] = {"$ne": "damaged"}
            existing = self.get_data(collection_name=collection_name, query=query)
            # prefer the plain "product" lot over accessories etc. sharing the same id
            existing.sort(key=lambda e: 0 if (e.get("product_type") or "product") == "product" else 1)
            if existing:
                entry = existing[0]
                current_serials = entry.get("serial_numbers") or []
                # never re-add a serial the lot already holds (double-return / retry)
                merged_serials = current_serials + [s for s in serial_numbers if s not in current_serials]
                added = len(merged_serials) - len(current_serials)
                # serialed units: quantity follows the serials actually added, so
                # quantity and serial count can't drift apart
                add_qty = added if serial_numbers else int(quantity or 0)
                new_quantity = int(entry.get("quantity", 0) or 0) + add_qty
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values={"serial_numbers": merged_serials, "quantity": new_quantity}
                )
                logging.info(f"restocked {quantity} returned unit(s) into existing inventory entry for {product_id}")
                return {"mode": "merged", "product_id": product_id, "quantity_added": quantity}

            from datetime import datetime, timezone
            fallback = inventory_manager(
                product_name=product_name,
                product_id=product_id,
                model_no=model_no or "",
                quantity=quantity,
                purchase_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                lot_no="",
                supplier="",
                price="",
                tax_rate=0,
                serial_numbers=list(serial_numbers or []),
                product_type="product",
            )
            logging.info(f"original lot for {product_id} no longer exists — created fallback entry for returned stock")
            return fallback.add(collection_name=collection_name)

        except Exception as e:
            logging.error("restocking returned unit(s) failed!")
            raise Exception(e)

    def update(self, collection_name, query, update_values, many=False):
        try:
            # a quantity of 0 (or below) is kept as a 0-quantity row - the entry is NOT deleted
            # automatically. Only the explicit "delete product" action removes an inventory row.
            new_quantity = update_values.get("quantity")
            if new_quantity is not None and int(new_quantity or 0) <= 0:
                update_values = dict(update_values, quantity=0)

            data = super().update_data(collection_name=collection_name, query=query,
                                         update_values=update_values, many=many)
            logging.info("value was updated to the inventory!")
            return data
        except Exception as e:
            logging.error("data updation unsuccessful")
            raise Exception(e)

    def _decrement_or_delete(self, collection_name, entry_id, new_quantity, extra_update_values=None):
        """
        Shared by every allocate/consume path below: applies a quantity
        decrement to the entry at entry_id. When the resulting quantity is 0
        (or less) the entry is KEPT as a 0-quantity row (never auto-deleted) -
        it is simply not eligible for allocation (every allocator filters
        quantity > 0) and shows as out of stock. extra_update_values (e.g. an
        updated serial_numbers/hologram_numbers list) are applied alongside.
        """
        new_quantity = max(int(new_quantity or 0), 0)
        update_values = {"quantity": new_quantity}
        if extra_update_values:
            update_values.update(extra_update_values)
        if new_quantity == 0 and "serial_numbers" in update_values:
            update_values["serial_numbers"] = []   # nothing left in stock -> no stray serials
        self.update_data(collection_name=collection_name, query={"_id": ObjectId(entry_id)},
                          update_values=update_values)
        if new_quantity == 0:
            logging.info(f"quantity reached 0 for entry {entry_id} — kept in inventory as out of stock")

    def get_data(self, collection_name, query=None, projection=None, sort=None, skip=None, limit=None):
        try:
            # Only forward sort/skip/limit when a caller actually asked for
            # them — the base mongodbclient.get_data() doesn't accept these
            # keywords at all, so always passing them through (even as None)
            # raised "unexpected keyword argument 'sort'" on every call that
            # went through this wrapper, including ones that never touch
            # sort/skip/limit in the first place.
            extra = {}
            if projection is not None:
                extra["projection"] = projection
            if sort is not None:
                extra["sort"] = sort
            if skip is not None:
                extra["skip"] = skip
            if limit is not None:
                extra["limit"] = limit
            dataset = super().get_data(collection_name=collection_name, query=query, **extra)
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

    def get_available_quantity(self, collection_name, product_id, model_no=None, product_name=None, product_type=None):
        try:
            query = self._identity_query(product_id, product_name, model_no, product_type)
            # model_no disambiguates between variants sharing the same product_id
            # (e.g. black vs grey) — only filter by it when one was actually given,
            # so callers that intentionally want the product_id-wide total still can
            entries = self.get_data(collection_name=collection_name, query=query)
            return sum(int(e.get("quantity", 0) or 0) for e in entries)
        except Exception as e:
            logging.error("checking available quantity failed!")
            raise Exception(e)

    @staticmethod
    def _part_query(product_name, product_type, parent_product_name=None, extra=None):
        """product_name + product_type, plus parent_product_name (the product the part
        belongs to) when given. Empty/None parent = legacy behaviour (match by name only)."""
        q = {"product_name": product_name, "product_type": product_type}
        if parent_product_name:
            q["parent_product_name"] = parent_product_name
        if extra:
            q.update(extra)
        return q

    def get_available_quantity_by_name(self, collection_name, product_name, product_type, parent_product_name=None):
        """
        Same idea as get_available_quantity, but for entries that have no
        natural product_id (e.g. spare_parts pushed in from a shipment) —
        sums quantity across every entry matching product_name + product_type.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query=self._part_query(product_name, product_type, parent_product_name)
            )
            return sum(int(e.get("quantity", 0) or 0) for e in entries)
        except Exception as e:
            logging.error("checking available quantity by name failed!")
            raise Exception(e)

    def get_hologram_available_by_name(self, collection_name, product_name, product_type, parent_product_name=None):
        """
        Sums how many hologram numbers are on file (across every matching lot)
        for a product_name + product_type — used before assembly to make sure
        there's a hologram number for every unit about to be consumed.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query=self._part_query(product_name, product_type, parent_product_name)
            )
            return sum(len(e.get("hologram_numbers") or []) for e in entries)
        except Exception as e:
            logging.error("checking available hologram numbers by name failed!")
            raise Exception(e)

    @staticmethod
    def _lot_snapshot(entry, take):
        return {
            "supplier": entry.get("supplier") or "",
            "supplier_address": entry.get("supplier_address") or "",
            "invoice_no": entry.get("invoice_no") or "",
            "purchase_date": entry.get("purchase_date") or "",
            "lot_no": entry.get("lot_no") or "",
            "quantity": take,
        }

    def consume_quantity(self, collection_name, product_name, product_type, quantity, parent_product_name=None, collect=None):
        """
        Deducts `quantity` units of a non-serialized product (e.g. a
        spare_parts entry) identified by product_name + product_type,
        oldest lots (by purchase_date) first. Raises if stock is insufficient.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query=self._part_query(product_name, product_type, parent_product_name, {"quantity": {"$gt": 0}})
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")
# jhdbfhb
            remaining = quantity
            for entry in entries:
                if remaining <= 0:
                    break
                available = int(entry.get("quantity", 0) or 0)
                take = min(remaining, available)
                if take <= 0:
                    continue
                if collect is not None:
                    collect.append(self._lot_snapshot(entry, take))
                self._decrement_or_delete(collection_name, entry["_id"], available - take)
                remaining -= take

            if remaining > 0:
                raise Exception(f"insufficient stock for '{product_name}', short by {remaining}")

            logging.info(f"consumed {quantity} unit(s) of '{product_name}' from {product_type}")
            return quantity
        except Exception as e:
            logging.error("consuming quantity from inventory failed!")
            raise Exception(e)

    def restock_quantity(self, collection_name, product_name, product_type, quantity, updated_by=None, parent_product_name=None):
        """
        Opposite of consume_quantity: puts `quantity` units of a non-serialized
        product (e.g. a spare_parts entry) back into inventory — used when an
        assembly is edited and fewer parts are needed than were first deducted.

        The units go back into the newest existing lot for that product_name +
        product_type. Used-up lots stay as 0-quantity rows, so they are reused;
        a fresh lot is only created when none exists at all.
        """
        try:
            quantity = int(quantity or 0)
            if quantity <= 0:
                return {"mode": "skipped", "quantity_added": 0}

            entries = self.get_data(
                collection_name=collection_name,
                query=self._part_query(product_name, product_type, parent_product_name)
            )
            if entries:
                entries.sort(key=lambda e: e.get("purchase_date") or "")
                entry = entries[-1]
                new_quantity = int(entry.get("quantity", 0) or 0) + quantity
                update_values = {"quantity": new_quantity}
                if updated_by:
                    update_values["updated_by"] = updated_by
                self.update_data(collection_name=collection_name, query={"_id": ObjectId(entry["_id"])},
                                 update_values=update_values)
                logging.info(f"restocked {quantity} unit(s) of '{product_name}' into existing {product_type} entry")
                return {"mode": "merged", "quantity_added": quantity}

            from datetime import datetime, timezone
            product_dic = {
                "product_name": product_name,
                "parent_product_name": parent_product_name or "",
                "product_id": f"SP-{uuid.uuid4().hex[:8].upper()}",
                "lot_no": "",
                "supplier": "",
                "supplier_address": "",
                "price": 0,
                "tax_rate": 0,
                "purchase_date": datetime.now(timezone.utc).date().isoformat(),
                "quantity": quantity,
                "model_no": "",
                "serial_numbers": [],
                "product_type": product_type,
                "part_category": None,
                "warranty_until": None,
                "hologram_numbers": [],
                "reason": "restocked from assembly edit",
                "created_by": updated_by,
                "updated_by": updated_by,
            }
            super().add(collection_name=collection_name, dictionary=product_dic)
            logging.info(f"created new {product_type} entry for restocked '{product_name}'")
            return {"mode": "created", "quantity_added": quantity}
        except Exception as e:
            logging.error("restocking quantity into inventory failed!")
            raise Exception(e)

    def allocate_hologram_numbers_by_name(self, collection_name, product_name, product_type, quantity, parent_product_name=None, collect=None):
        """
        Deducts `quantity` units of a spare_parts/service_parts entry (matched by
        product_name + product_type) AND pulls that many hologram numbers along with
        it — oldest lots first, same pattern as allocate_serials below. Every unit
        consumed this way must have its own hologram number on file; raises if
        either the stock or the hologram numbers on file fall short. Returns the
        flat list of hologram numbers taken, in the order they were consumed — this
        becomes the per-unit hologram_number for the assembly's serials.
        """
        try:
            entries = self.get_data(
                collection_name=collection_name,
                query=self._part_query(product_name, product_type, parent_product_name, {"quantity": {"$gt": 0}})
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            # verify enough hologram numbers exist across all matching lots before touching anything
            total_hologram = sum(len(e.get("hologram_numbers") or []) for e in entries)
            if total_hologram < quantity:
                raise Exception(
                    f"only {total_hologram} hologram number(s) on file for '{product_name}', need {quantity}"
                )

            remaining = quantity
            allocated = []
            for entry in entries:
                if remaining <= 0:
                    break
                available_qty = int(entry.get("quantity", 0) or 0)
                available_hologram = entry.get("hologram_numbers") or []
                take = min(remaining, available_qty, len(available_hologram))
                if take <= 0:
                    continue
                taken = available_hologram[:take]
                leftover_hologram = available_hologram[take:]
                new_quantity = available_qty - take
                if collect is not None:
                    collect.append(self._lot_snapshot(entry, take))
                self._decrement_or_delete(collection_name, entry["_id"], new_quantity,
                                           {"hologram_numbers": leftover_hologram})
                allocated.extend(taken)
                remaining -= take

            if remaining > 0:
                raise Exception(f"insufficient hologram-tagged stock for '{product_name}', short by {remaining}")

            logging.info(f"allocated {len(allocated)} hologram number(s) for '{product_name}'")
            return allocated
        except Exception as e:
            logging.error("hologram number allocation failed!")
            raise Exception(e)

    def allocate_specific_holograms(self, collection_name, hologram_numbers, product_name=None):
        """
        Deducts exactly the given hologram numbers from spare_parts / service_parts lots:
        each lot that holds any of them loses those hologram numbers and the same number
        of units. Everything is checked first, so if any hologram number is not on file
        nothing is deducted. Returns the list of hologram numbers taken.
        """
        try:
            wanted = list(dict.fromkeys(str(h).strip() for h in (hologram_numbers or []) if h and str(h).strip()))
            if not wanted:
                return []
            query = {"hologram_numbers": {"$in": wanted}, "product_type": {"$in": ["spare_parts", "service_parts"]}}
            if product_name:
                query["product_name"] = product_name
            lots = self.get_data(collection_name=collection_name, query=query)

            found = {}
            for lot in lots:
                for h in (lot.get("hologram_numbers") or []):
                    if h in wanted and h not in found:
                        found[h] = lot["_id"]
            missing = [h for h in wanted if h not in found]
            if missing:
                raise Exception(f"hologram number(s) not available in inventory: {', '.join(missing[:10])}")

            for lot in lots:
                taken = [h for h in wanted if found.get(h) == lot["_id"]]
                if not taken:
                    continue
                leftover = [h for h in (lot.get("hologram_numbers") or []) if h not in taken]
                new_quantity = int(lot.get("quantity", 0) or 0) - len(taken)
                self._decrement_or_delete(collection_name, lot["_id"], new_quantity, {"hologram_numbers": leftover})

            logging.info(f"allocated {len(wanted)} specific hologram number(s)")
            return wanted
        except Exception as e:
            logging.error("allocating specific hologram number(s) failed!")
            raise Exception(e)

    def consume_from_lot(self, collection_name, lot_id, quantity, product_name=None):
        """
        Deducts `quantity` units from ONE specific inventory lot (by its _id) — used for items
        given out by quantity only (accessories, parts without hologram numbers). If the lot
        carries serial numbers, the same number of serials leave with it so quantity and serial
        count never drift apart. Returns the serial numbers taken (may be empty).
        """
        try:
            quantity = int(quantity or 0)
            if quantity <= 0:
                raise Exception("quantity must be greater than 0")
            lots = self.get_data(collection_name=collection_name, query={"_id": ObjectId(lot_id)})
            if not lots:
                raise Exception("selected inventory item was not found, refresh and try again")
            lot = lots[0]
            if product_name and lot.get("product_name") != product_name:
                raise Exception("selected inventory item changed, refresh and try again")
            available = int(lot.get("quantity", 0) or 0)
            if available < quantity:
                raise Exception(f"insufficient stock for '{lot.get('product_name')}': only {available} available")
            serials = lot.get("serial_numbers") or []
            taken = serials[:min(quantity, len(serials))]
            self._decrement_or_delete(collection_name, lot["_id"], available - quantity,
                                       {"serial_numbers": serials[len(taken):]})
            logging.info(f"consumed {quantity} unit(s) from lot {lot_id}")
            return taken
        except Exception as e:
            logging.error("consuming from specific lot failed!")
            raise Exception(e)

    @staticmethod
    def _model_query(model_no):
        """model_no "" / None both mean "no variant" — old lots store null, not "".
        A given model_no is matched ignoring case and leading/trailing spaces, so a request
        raised with "XY-100" still finds a lot that was later saved as "xy-100 " (this
        mismatch used to show up as a false "out of stock")."""
        if not model_no or not str(model_no).strip():
            return {"$in": [None, ""]}
        return {"$regex": "^\\s*" + re.escape(str(model_no).strip()) + "\\s*$", "$options": "i"}

    @staticmethod
    def _text_query(value):
        """Case-insensitive match ignoring leading/trailing spaces."""
        return {"$regex": "^\\s*" + re.escape(str(value).strip()) + "\\s*$", "$options": "i"}

    def _identity_query(self, product_id, product_name=None, model_no=None, product_type=None):
        """Which inventory lots count as "the same product".
        With a product_name the identity is product name + model no + product type -
        product_id is deliberately NOT used (inventory products now all carry a blank / single-space
        id, so it can't tell products apart and a mismatch caused false "out of stock").
        model_no "" / None = no variant. product_type "" / None = any live (non-damaged) type;
        "product" also matches older lots that have no product_type saved.
        Callers that only have a product_id (no name) keep the old product_id matching."""
        if product_name and str(product_name).strip():
            q = {"product_name": self._text_query(product_name), "model_no": self._model_query(model_no)}
        else:
            q = {"product_id": product_id}
            if model_no is not None:
                q["model_no"] = self._model_query(model_no)
        t = (product_type or "").strip()
        if t == "product":
            q["product_type"] = {"$in": [None, "", "product"]}
        elif t:
            q["product_type"] = t
        else:
            q["product_type"] = {"$ne": "damaged"}
        return q

    def list_available_serials(self, collection_name, product_id, model_no=None, product_name=None, product_type=None):
        """
        Returns every serial number currently on file for product_id (optionally
        scoped to a single model_no variant), oldest lot first — the exact same
        order allocate_serials/allocate_units would consume them in. Used to
        populate the order review step's serial-number picker, so the "default"
        selection shown to the user matches what auto-allocation would have
        picked, and the rest of the list is what's available to switch to.
        """
        try:
            # damaged lots share product_id/model_no with the live lot — they must
            # never show up as available (that was leaking faulty serials into orders)
            query = self._identity_query(product_id, product_name, model_no, product_type)
            query["quantity"] = {"$gt": 0}
            entries = self.get_data(collection_name=collection_name, query=query)
            entries.sort(key=lambda e: e.get("purchase_date") or "")
            serials, seen = [], set()
            for entry in entries:
                # a lot can never hand out more serials than it has units: stale lots that list
                # more serials than `quantity` would otherwise leak phantom (extra) serials
                lot_qty = int(entry.get("quantity", 0) or 0)
                for s in (entry.get("serial_numbers") or [])[:lot_qty]:
                    key = str(s).strip().lower()
                    if key not in seen:
                        seen.add(key)
                        serials.append(s)
            return serials
        except Exception as e:
            logging.error("listing available serial numbers failed!")
            raise Exception(e)

    def allocate_specific_serials(self, collection_name, product_id, serial_numbers, model_no=None, product_name=None, product_type=None):
        """
        Deducts exactly the given serial_numbers (a manual/reviewed selection
        from the order UI, as opposed to allocate_serials' auto oldest-first
        pick) — one unit per serial, decrementing whichever lot each serial
        actually belongs to. model_no scopes the search to a single variant's
        lots, same as allocate_serials/allocate_units, so a serial can't be
        pulled from the wrong variant.

        Every serial must currently exist in some matching lot's serial_numbers
        list; if any one of them isn't found (already allocated to another
        order in the meantime, mistyped, or belongs to a different product),
        the whole call raises before anything is deducted for THAT serial —
        serials already processed earlier in the same call are not rolled
        back, matching this codebase's existing non-transactional style
        elsewhere (e.g. allocate_serials/allocate_units).
        """
        try:
            query = self._identity_query(product_id, product_name, model_no, product_type)
            query["quantity"] = {"$gt": 0}
            entries = self.get_data(collection_name=collection_name, query=query)

            allocated = []
            for serial in serial_numbers:
                # only lots that still have stock left in THIS call (a lot emptied by an earlier
                # serial is already deleted - it must not be matched / decremented again)
                match = next((e for e in entries
                              if int(e.get("quantity", 0) or 0) > 0 and serial in (e.get("serial_numbers") or [])), None)
                if not match:
                    variant_note = f" (model {model_no})" if model_no else ""
                    raise Exception(f"serial number {serial} is not available for product {product_id}{variant_note}")

                leftover_serials = [s for s in (match.get("serial_numbers") or []) if s != serial]
                new_quantity = int(match.get("quantity", 0) or 0) - 1
                self._decrement_or_delete(collection_name, match["_id"], new_quantity,
                                           {"serial_numbers": leftover_serials})
                # keep our local view in sync so two requested serials from the
                # same lot in one call don't both match the stale entry
                match["serial_numbers"] = leftover_serials
                match["quantity"] = new_quantity

                allocated.append(serial)

            logging.info(f"allocated {len(allocated)} specific serial(s) for product {product_id}")
            return allocated
        except Exception as e:
            logging.error("allocating specific serial number(s) failed!")
            raise Exception(e)
        """
        Pulls `quantity` serial numbers out of inventory for product_id (oldest lots first),
        decrementing each lot's quantity and removing the used serials. Returns the list of
        serial numbers allocated. Raises if stock is insufficient.

        model_no disambiguates between variants that share the same product_id
        (e.g. the same product in black vs grey, each its own model_no lot) — when
        given, only lots for that exact model_no are eligible, so a request for
        one variant can never silently pull serials from another.
        """
        try:
            query = {"product_id": product_id, "quantity": {"$gt": 0}}
            if model_no is not None:
                query["model_no"] = model_no
            entries = self.get_data(
                collection_name=collection_name,
                query=query
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
                variant_note = f" (model {model_no})" if model_no else ""
                raise Exception(f"insufficient stock for product {product_id}{variant_note}, short by {remaining}")

            logging.info(f"allocated {len(allocated)} serials for product {product_id}")
            return allocated

        except Exception as e:
            logging.error("serial allocation failed!")
            raise Exception(e)

    def unserialised_quantity(self, collection_name, product_id, model_no=None, product_name=None, product_type=None):
        """
        Units in stock that are NOT backed by a serial number on file: for every live lot,
        quantity minus the serials listed on it (never below 0). A lot with quantity 5 and
        2 serials on file has 3 such units. Used so a partially serialised lot is not
        reported as "short" when only its serial list is shorter than its quantity.
        """
        try:
            query = self._identity_query(product_id, product_name, model_no, product_type)
            query["quantity"] = {"$gt": 0}
            entries = self.get_data(collection_name=collection_name, query=query)
            total = 0
            for e in entries:
                qty = int(e.get("quantity", 0) or 0)
                total += max(0, qty - len(e.get("serial_numbers") or []))
            return total
        except Exception as e:
            logging.error("counting unserialised units failed!")
            raise Exception(e)

    def allocate_unserialised_units(self, collection_name, product_id, quantity, model_no=None, product_name=None, product_type=None):
        """
        Deducts `quantity` units that have no serial number on file (see unserialised_quantity),
        oldest lot first. Only the lot quantity goes down - serial numbers listed on a lot are
        never touched, so serials that were skipped (e.g. already sold) stay exactly as they are.
        Raises if there are fewer such units than requested.
        """
        try:
            query = self._identity_query(product_id, product_name, model_no, product_type)
            query["quantity"] = {"$gt": 0}
            entries = self.get_data(collection_name=collection_name, query=query)
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            remaining = quantity
            for entry in entries:
                if remaining <= 0:
                    break
                qty = int(entry.get("quantity", 0) or 0)
                free = qty - len(entry.get("serial_numbers") or [])
                take = min(remaining, free)
                if take <= 0:
                    continue
                self._decrement_or_delete(collection_name, entry["_id"], qty - take)
                remaining -= take

            if remaining > 0:
                variant_note = f" (model {model_no})" if model_no else ""
                raise Exception(f"insufficient un-serialised stock for product {product_id}{variant_note}, short by {remaining}")
            logging.info(f"allocated {quantity} un-serialised unit(s) for product {product_id}")
        except Exception as e:
            logging.error("un-serialised unit allocation failed!")
            raise Exception(e)

    def allocate_units(self, collection_name, product_id, quantity, model_no=None, product_name=None, product_type=None):
        """
        Deducts `quantity` units of product_id from inventory (oldest lots first) —
        for use anywhere a full quantity+serials list is recorded together (e.g. an
        order line or a demo-unit allocation line), as opposed to allocate_serials'
        one-record-per-serial callers which genuinely need every unit serialed.

        model_no disambiguates between variants that share the same product_id
        (e.g. the same product in black vs grey, each its own model_no lot) — when
        given, only lots for that exact model_no are eligible, so a line ordered
        for one variant can never silently pull stock/serials from another.

        Unlike allocate_serials, this does NOT require every lot to carry serial
        numbers: accessories/spare_parts/service_parts are allowed to be stocked
        with no serial numbers on file (see /inventory/create), so a lot with
        quantity > 0 but an empty serial_numbers list is still valid stock and
        must not raise "insufficient stock". Wherever a lot does have serials on
        file, the matching number of serials is pulled and returned so the caller
        can still record which units shipped for serialized products.

        Returns the list of serial numbers collected — this may be SHORTER than
        `quantity` (or empty) when the consumed lots weren't serial-tracked; that
        is expected and not an error. Raises only if total on-file quantity across
        all matching lots is insufficient.
        """
        try:
            query = self._identity_query(product_id, product_name, model_no, product_type)
            query["quantity"] = {"$gt": 0}
            entries = self.get_data(
                collection_name=collection_name,
                query=query
            )
            entries.sort(key=lambda e: e.get("purchase_date") or "")

            remaining = quantity
            allocated = []

            for entry in entries:
                if remaining <= 0:
                    break

                available_qty = int(entry.get("quantity", 0) or 0)
                take = min(remaining, available_qty)
                if take <= 0:
                    continue

                available_serials = entry.get("serial_numbers") or []
                serial_take = min(take, len(available_serials))
                taken_serials = available_serials[:serial_take]
                leftover_serials = available_serials[serial_take:]

                self._decrement_or_delete(collection_name, entry["_id"], available_qty - take,
                                           {"serial_numbers": leftover_serials})

                allocated.extend(taken_serials)
                remaining -= take

            if remaining > 0:
                variant_note = f" (model {model_no})" if model_no else ""
                raise Exception(f"insufficient stock for product {product_id}{variant_note}, short by {remaining}")

            logging.info(f"allocated {quantity} unit(s) ({len(allocated)} serialed) for product {product_id}{' model ' + model_no if model_no else ''}")
            return allocated

        except Exception as e:
            logging.error("unit allocation failed!")
            raise Exception(e)

    @staticmethod
    def _merge_lot_numbers(existing_lot_no, new_lots):
        """Inventory keeps ONE lot_no text per entry: distinct lot numbers joined by ", " (old first,
        then new ones in the order they arrive). An assembly can bring several lots into one entry."""
        merged = []
        for lot in [x.strip() for x in str(existing_lot_no or "").split(",")] + [str(x or "").strip() for x in new_lots]:
            if lot and lot not in merged:
                merged.append(lot)
        return ", ".join(merged)

    def add_from_assembly(self, collection_name, product_name, product_id, model_no, quantity,
                           serial_numbers, price=0, tax_rate=0, purchase_date=None,
                           supplier="In-house Assembly", supplier_address="", lot_no="",
                           product_type="product", serial_lots=None):
        """
        Called right after an Assembly is marked completed, to push the
        freshly built units into inventory.

        If an inventory entry already exists with the same product_name +
        product_id + model_no, the assembled serial numbers are appended to
        that entry and its quantity is increased by `quantity`. Otherwise a
        brand new inventory entry is created for this assembled batch.

        serial_lots: list of {"serial_number", "lot_no"} for the units being added (from the assembly).
        The lot numbers are stored on the entry — as distinct, comma-joined `lot_no` text plus a per-serial
        `serial_lots` list — so the same lot numbers entered in the assembly show up in inventory.

        Returns {"mode": "merged" | "created", "product_id": ..., "quantity_added": ...}
        """
        try:
            if not product_name:
                raise Exception("assembled product must have a product name")
            product_id = product_id if product_id else " "
            if not quantity or quantity <= 0:
                raise Exception("assembled quantity must be greater than 0")

            existing = self.get_data(
                collection_name=collection_name,
                query={"product_name": product_name, "product_id": product_id,
                       "model_no": self._model_query(model_no), "product_type": product_type}
            )

            lot_entries = [{"serial_number": (x.get("serial_number") or ""), "lot_no": (x.get("lot_no") or "").strip()}
                           for x in (serial_lots or []) if x.get("serial_number")]
            new_lot_values = [x["lot_no"] for x in lot_entries]

            if existing:
                entry = existing[0]
                merged_serials = (entry.get("serial_numbers") or []) + list(serial_numbers)
                new_quantity = int(entry.get("quantity", 0) or 0) + quantity

                update_values = {"serial_numbers": merged_serials, "quantity": new_quantity}
                if lot_entries:
                    update_values["lot_no"] = self._merge_lot_numbers(entry.get("lot_no"), new_lot_values)
                    update_values["serial_lots"] = (entry.get("serial_lots") or []) + lot_entries
                self.update_data(
                    collection_name=collection_name,
                    query={"_id": ObjectId(entry["_id"])},
                    update_values=update_values
                )
                logging.info(f"merged {quantity} assembled unit(s) into existing inventory entry for {product_id}")
                return {"mode": "merged", "product_id": product_id, "quantity_added": quantity}

            product_dic = {
                "product_name": product_name,
                "product_id": product_id,
                "lot_no": self._merge_lot_numbers(lot_no, new_lot_values) if lot_entries else lot_no,
                "supplier": supplier,
                "supplier_address": supplier_address,
                "price": price,
                "tax_rate": tax_rate,
                "purchase_date": purchase_date,
                "quantity": quantity,
                "model_no": model_no,
                "serial_numbers": list(serial_numbers),
                "product_type": product_type,
            }
            if lot_entries:
                product_dic["serial_lots"] = lot_entries
            super().add(collection_name=collection_name, dictionary=product_dic)
            logging.info(f"created new inventory entry for assembled product {product_id}")
            return {"mode": "created", "product_id": product_id, "quantity_added": quantity}

        except Exception as e:
            logging.error("pushing assembled units into inventory failed!")
            raise Exception(e)

    def add_from_shipment_parts(self, collection_name, parts, product_type,
                                 supplier="", supplier_address="", purchase_date=None, lot_no="", invoice_no=""):
        """
        Called right after a Shipment is marked received, to push its parts
        into inventory — grouped here by product_type so the caller decides
        which bucket they land in:
          - parts marked "assembly" on the shipment -> product_type="spare_parts"
          - parts marked "purchase" / "warranty" on the shipment -> product_type="service_parts"

        parts: list of {
            "part_name": str,
            "parent_product_name": str,                        # which shipment product this part belongs to
            "quantity": int,
            "part_category": "purchase" | "warranty" | None,  # only meaningful for service_parts
            "warranty_until": "YYYY-MM-DD" | None,             # only meaningful when part_category == "warranty"
        }

        Unlike assembled units, shipment parts have no serial numbers (they're
        tracked purely by quantity) and no natural product_id, so:
          - if an inventory entry with the same product_name + parent_product_name +
            product_type + part_category + purchase_date + warranty_until already
            exists, its quantity is simply increased
          - otherwise a new entry is created with an auto-generated product_id

        purchase_date and warranty_until are part of the match on purpose: two
        shipments of the "same" part received on different dates, or covered by
        different warranty windows, must NOT collapse into one inventory row —
        each stays its own lot with its own date/warranty so nothing gets mixed.

        Returns a list of {"part_name", "mode": "merged" | "created", "quantity_added"}
        """
        try:
            results = []
            for part in parts:
                part_name = (part.get("part_name") or "").strip()
                parent_product_name = (part.get("parent_product_name") or "").strip()
                quantity = part.get("quantity", 0) or 0
                if not part_name or quantity <= 0:
                    continue

                part_category = part.get("part_category")     # None | "purchase" | "warranty"
                warranty_until = part.get("warranty_until")    # only set for "warranty"

                # keep purchase / warranty batches of the same part separate,
                # and keep the same part name sourced from different products
                # separate too, so their category/parent isn't lost on merge.
                # purchase_date and warranty_until are ALSO part of the match:
                # two shipments of the same part received on different dates,
                # or with different warranty windows, must land in separate
                # inventory rows instead of merging their quantity together
                # (which would silently mix two different dates/warranties).
                match_query = {
                    "product_name": part_name,
                    "parent_product_name": parent_product_name,
                    "product_type": product_type,
                    "purchase_date": purchase_date,
                    "warranty_until": warranty_until,
                }
                if part_category:
                    match_query["part_category"] = part_category
                if invoice_no:
                    match_query["invoice_no"] = invoice_no

                existing = self.get_data(collection_name=collection_name, query=match_query)

                if existing:
                    # purchase_date and warranty_until are guaranteed identical
                    # to the existing entry here (they're part of match_query
                    # above), so merging only ever adds quantity - it never
                    # overwrites/mixes a different date or warranty window.
                    entry = existing[0]
                    new_quantity = int(entry.get("quantity", 0) or 0) + quantity
                    self.update_data(
                        collection_name=collection_name,
                        query={"_id": ObjectId(entry["_id"])},
                        update_values={"quantity": new_quantity}
                    )
                    logging.info(f"merged {quantity} unit(s) of '{part_name}' into existing {product_type} entry")
                    results.append({"part_name": part_name, "mode": "merged", "quantity_added": quantity})
                else:
                    product_id = f"SP-{uuid.uuid4().hex[:8].upper()}"
                    product_dic = {
                        "product_name": part_name,
                        "parent_product_name": parent_product_name,
                        "product_id": product_id,
                        "lot_no": lot_no,
                        "supplier": supplier,
                        "supplier_address": supplier_address,
                        "invoice_no": invoice_no or "",
                        "price": 0,
                        "tax_rate": 0,
                        "purchase_date": purchase_date,
                        "quantity": quantity,
                        "model_no": "",
                        "serial_numbers": [],
                        "product_type": product_type,
                        "part_category": part_category,
                        "warranty_until": warranty_until,
                    }
                    super().add(collection_name=collection_name, dictionary=product_dic)
                    logging.info(f"created new {product_type} inventory entry for '{part_name}'")
                    results.append({"part_name": part_name, "mode": "created", "quantity_added": quantity})

            return results

        except Exception as e:
            logging.error("pushing shipment parts into inventory failed!")
            raise Exception(e)