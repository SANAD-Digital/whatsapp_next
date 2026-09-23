# Frappe UI Visual Reference

This folder is a **visual and design reference only** for how Frappe / ERPNext data should be presented in user interfaces.

The images are not screens that must be copied literally, and they do not explain application architecture or implementation. Their purpose is to define **how data should look visually to the user** so that it is clear, consistent, easy to scan, and understandable at a glance.

## Purpose of This Reference

Use these images to standardize the visual presentation language across the interface, especially when displaying:

- People, contacts, users, and employees.
- Items and products.
- Linked documents.
- Images and attachments.
- Values, statuses, dates, and amounts.
- Tables, lists, and collections.
- Compact or detailed representations of the same data depending on context and available space.

The core principle is: **the same type of data may have more than one visual representation depending on where it appears, how important it is, and how much information needs to be shown.**

---

# General Design Rules

## 1. Clear Visual Hierarchy

The user should be able to understand immediately:

1. What is this item or document?
2. What is its status?
3. What is the most important value or information?
4. What secondary information is related to it?
5. What actions are available?

Do not give every field the same visual weight.

## 2. Prioritize Important Content

- The primary name or title should be the clearest element.
- Status should be easy to identify using a badge or another clear indicator.
- A primary value such as amount, price, or progress should be visually prominent.
- Secondary data should use smaller typography and lower visual emphasis.
- Technical or low-priority details should not compete with the main information.

## 3. Reduce Visual Noise

- Do not use a Card for every field.
- Prefer whitespace and separators before adding more containers.
- Limit colors to meaningful semantic states.
- Do not repeat the same information in multiple places without a reason.
- Use icons to improve scanability, not as decoration.

## 4. Visual Consistency

Keep the following consistent:

- Heading sizes.
- Internal and external spacing.
- Badge styles.
- Thumbnail sizes.
- Icon placement.
- Border styles.
- Action button styles.
- Semantic colors for similar states.

---

# Display Density Variants

The same data may be shown at different levels of detail. The reference images demonstrate five common levels:

### Inline View

For very tight spaces, tables, or links inside text.

Usually shows:

- Name or identifier.
- Small icon or image when useful.
- Only one secondary piece of information.

### Compact View

For dense lists and quick results.

Usually shows:

- Name.
- Type or short description.
- Status or primary value.
- Small image if useful.

### Row View

For lists inside a Drawer, forms, or selection results.

Usually shows:

- Image or icon.
- Name.
- Two or three secondary details.
- Status or key value.
- Arrow or simple action.

### Card View

When the item needs more visual space or contains an image or several important details.

Usually shows:

- Image or Avatar.
- Name.
- Description or type.
- Status.
- Important value.
- Short additional details.

### Hero View

When the item is the main focus of the screen or section.

May show:

- Larger image.
- Clear title.
- Status.
- Primary values.
- Supporting information.
- Related actions.

---

# Image Guide

## 01 — Universal Document Drawer

`01-universal-document-drawer.png`

A reference for the overall visual structure when displaying a document inside a Drawer.

It focuses on:

- A clear Header.
- Document title and identity.
- Status and time.
- Primary content.
- Quick facts.
- Related entities.
- Additional details.
- Activity history.
- Bottom actions.

Visually, the user should be able to understand the document quickly without feeling that they are looking at a long Form.

---

## 02 — People and Entities

`02-people-contact-user-employee-renderers.png`

A reference for displaying:

- Contact.
- User.
- Employee.
- Similar person-like or organization-like entities.

Pay attention to how the presentation changes based on available space.

In a small view, it may be enough to show:

- Avatar or Icon.
- Name.
- Type or role.

In a larger view, you may add:

- Phone number.
- Email.
- Branch.
- Job title.
- Status.
- Actions.

A profile image is a strong visual aid for distinguishing people, so it should be used when available and useful.

---

## 03 — Items and Products

`03-item-product-renderers.png`

A reference for displaying an Item or Product in different visual forms.

The most important visual elements are usually:

- Product image.
- Item name.
- Item code.
- Price.
- Stock status.
- Quantity.
- Item group.

In tables, the image should be small and the information compact.

In cards, the image becomes more important and the price and status are more prominent.

In a Hero view, you may use a larger image, additional images, stock information, and price as prominent values.

---

## 04 — Linked Documents

`04-linked-document-renderers.png`

A reference for displaying documents such as:

- Sales Invoice.
- Purchase Invoice.
- Payment Entry.
- Delivery Note.
- Task.
- Project.

Do not show only the document number when the context allows more useful information.

A good display may combine:

- Document number.
- Document type.
- Related party.
- Date.
- Amount or progress.
- Status.

Financial documents should give more visual weight to the amount, while Tasks and Projects should give more weight to status and progress.

---

## 05 — Images and Attachments

`05-image-attachment-renderers.png`

A reference for displaying:

- Attach.
- Attach Image.
- Image.
- Different file types.
- Multiple images.

The presentation should change based on content:

- Avatar for profile images.
- Thumbnail for product images.
- File Row for attachments inside a list.
- Compact File Chip for tight spaces.
- Thumbnail Card when preview is important.
- Gallery when there are multiple images.
- Document Preview when showing the document content visually is useful.

The user should clearly see the file type, file name, size, and available actions without needing to read the file path.

---

## 06 — Values and Statuses

`06-value-status-renderers.png`

A reference for presenting simple values in a clearer way than raw text.

Includes examples for:

- Status.
- Currency.
- Number.
- Percent.
- Date.
- Datetime.
- Boolean.
- Rating.
- Tags.
- Location.
- JSON / Code Preview.

### Status

Use a clear Badge with consistent semantic coloring.

### Amount

- Inside a row: formatted value.
- Inside a summary: larger and more prominent value.
- Inside a total: it may receive stronger visual emphasis.

### Percentage

Use the number alone when that is sufficient, and use a Progress Bar when progress or comparison is visually more important.

### Date and Time

Use a human-readable format and avoid long technical timestamps in the primary view.

### Boolean

In read-only presentation, use Yes / No or an appropriate Badge instead of a Checkbox that may imply the field is editable.

### Tags

Use small Chips and do not allow them to dominate the interface.

### Location

You may show the place name, coordinates, or a small map preview depending on how important location is in the context.

---

## 07 — Tables and Collections

`07-table-collection-renderers.png`

A reference for the idea that multi-row data should not always appear as a traditional table.

Examples:

### Items

They may be shown as:

- Table.
- Compact List.
- Cards.
- Gallery.

### Contacts

A list or row layout is often better than a table full of text.

### Accounting Entries and Financial Movements

A table is usually the best option because comparison between columns is important.

### Activity History

A Timeline is better than a table because time and sequence are the most important parts of the information.

The choice of presentation should depend on **the nature of the content and how the user needs to read it**, not simply on whether the data contains multiple rows.

---

# Reference Images

1. `01-universal-document-drawer.png` — Overall document presentation inside a Drawer.
2. `02-people-contact-user-employee-renderers.png` — People, contacts, users, and employees.
3. `03-item-product-renderers.png` — Items and products.
4. `04-linked-document-renderers.png` — Linked documents.
5. `05-image-attachment-renderers.png` — Images, attachments, and files.
6. `06-value-status-renderers.png` — Values, statuses, dates, amounts, and related fields.
7. `07-table-collection-renderers.png` — Tables, lists, cards, collections, and activity history.

---

# Final Standard

When using these references, the goal is not to turn all data into Cards or make every screen look identical.

The goal is to give each type of data **an appropriate visual presentation**, with more than one display level for the same type depending on context, while keeping all representations within one consistent design language.

A good result should allow the user to quickly distinguish between:

- Person.
- Item.
- Document.
- Amount.
- Status.
- File.
- Image.
- Item list.
- Activity history.

The user should be able to understand the most important information at a glance without visual clutter or unnecessary decoration.
