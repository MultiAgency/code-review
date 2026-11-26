# 07 Purchases and the organization's reviews share budget and capacity

Status: needs-triage
Type: decision
Blocked by: none

Purchased reviews run in the same queue as the organization's own, under the same `MAX_CONCURRENT_REVIEWS` and the
same daily spend limit, although they bill a different key. A day of purchases can hold up or stop the team's reviews,
and the team's reviews can make a purchase wait into its payment window (03).

Decide whether purchases get their own daily limit and a share of the concurrency, or whether sharing is fine at the
volumes expected.
