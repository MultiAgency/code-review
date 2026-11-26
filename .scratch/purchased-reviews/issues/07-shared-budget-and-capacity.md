# 07 Purchases and the organization's reviews share budget and capacity

Status: wontfix
Type: decision
Blocked by: none

Purchased reviews run in the same queue as the organization's own, under the same `MAX_CONCURRENT_REVIEWS` and the
same daily spend limit, although they bill a different key. A day of purchases can hold up or stop the team's reviews,
and the team's reviews can make a purchase wait into its payment window (03).

Decide whether purchases get their own daily limit and a share of the concurrency, or whether sharing is fine at the
volumes expected.

## Comments

2026-11-26, decided: share for now. At about $0.70 a review and low expected volume, the $50 daily limit and two
review slots are enough for both. Revisit when `GET /sales` on the gateway shows real volume.

