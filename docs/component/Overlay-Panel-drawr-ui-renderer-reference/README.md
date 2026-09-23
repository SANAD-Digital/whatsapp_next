# Frappe Universal Renderer UI References

Reference images for implementing a reusable presentation/rendering system in Frappe/ERPNext.

1. `01-universal-document-drawer.png` — Universal document drawer / overall composition.
2. `02-people-contact-user-employee-renderers.png` — Contact, User and Employee renderer variants.
3. `03-item-product-renderers.png` — Item/Product renderer variants.
4. `04-linked-document-renderers.png` — Linked document renderer variants.
5. `05-image-attachment-renderers.png` — Image, Attach Image and file attachment variants.
6. `06-value-status-renderers.png` — Status, currency, number, percent, date, boolean, rating, tags, location and JSON.
7. `07-table-collection-renderers.png` — Child Table / collection layouts: table, list, cards and timeline.

Recommended implementation model:
`Frappe Meta -> Field/Entity classification -> Context resolver -> Variant resolver -> Renderer`

Suggested variants:
`inline | compact | row | card | hero`
