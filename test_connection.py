"""
One-time migration: backfills the `allocated_by` field on existing
allocation_type="product" allocations that were created by the old
/allocation/create flow (before it started setting allocated_by).

Without this backfill, the app.py fix (which makes /allocation/mine and
/allocation/team also look for allocation_type "product") still won't
show OLD rows, because their allocated_by is empty/missing and the
query can't match on it.

Run this ONCE, from the same folder as app.py (so its imports resolve),
after deploying the updated app.py:

    python backfill_allocated_by.py

It is safe to re-run: it only touches documents whose allocated_by is
still empty/missing, so already-fixed or already-correct rows are
left untouched.
"""

from allocation.allocation import allocation_manager
from configuration import load_params
from logger import logging

params = load_params()
ALLOCATION_COLLECTION = params.get("allocation_collection_name", "allocations")


def backfill():
    db = allocation_manager()

    # Every "product"-type allocation whose allocated_by is missing, empty
    # string, or explicitly null.
    candidates = db.get_data(
        collection_name=ALLOCATION_COLLECTION,
        query={
            "allocation_type": "product",
            "$or": [
                {"allocated_by": {"$exists": False}},
                {"allocated_by": None},
                {"allocated_by": ""},
            ],
        },
    )

    print(f"found {len(candidates)} product allocation(s) with no allocated_by")

    fixed = 0
    skipped = 0
    for doc in candidates:
        allocation_id = doc.get("allocation_id")
        sales_person = doc.get("sales_person") or {}
        # username / sales_person_id are the same value — see _user_snapshot()
        username = sales_person.get("username") or sales_person.get("sales_person_id")

        if not username:
            print(f"  SKIP {allocation_id}: no sales_person.username on this doc, fix manually")
            skipped += 1
            continue

        db.update_data(
            collection_name=ALLOCATION_COLLECTION,
            query={"allocation_id": allocation_id},
            update_values={"allocated_by": username},
        )
        print(f"  fixed {allocation_id} -> allocated_by = {username}")
        fixed += 1

    print(f"\ndone. fixed={fixed} skipped={skipped}")


if __name__ == "__main__":
    backfill()