# Dedicated Portals sidebar section

## Scope
- Move Finance Portal, Solicitor Portal, and Client Portal out of Administration.
- Add a prominent, collapsible **Portals** section between **Operations** and **Help & Usage**.
- Preserve every existing URL, icon, capability check, active state, mobile entry, and command-palette entry.

## Implementation
- Reclassify only the three portal administration links in the shared navigation registry.
- Render portal links as their own fail-closed group on desktop and mobile, without treating them as ordinary always-visible navigation.
- Keep the remaining Administration links and styling unchanged.
- Update navigation contract tests to pin the new placement and prevent the portals returning to Administration.

## Verification
- Run focused navigation tests, TypeScript checks, style audit, lint, and the production build.
- Verify the sidebar order and collapse behaviour in the browser where the available session permits it.
