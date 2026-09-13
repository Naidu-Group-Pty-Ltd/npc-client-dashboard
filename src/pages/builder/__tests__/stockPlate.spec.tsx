import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { StockPlate } from '@/pages/builder/BuilderStockList';
import type { BuilderStockItem, BuilderStockImage } from '@/lib/builderStock';

/**
 * THE STOCK LIST SHOWS THE BUILDER THEIR HOUSES.
 *
 * This page rendered zero `<img>` elements. Every builder's own imagery was
 * discovered, de-duplicated, classified, ranked, stored and signed — and the
 * page showed them a status word instead. The server's `image_url` operation
 * was live and `builderStockImageUrl` was written; it had no caller anywhere.
 *
 * The first assertion here is the whole defect: a property that HAS a picture
 * draws one. Everything else checks that making the plate did not cost a fact
 * or a control the two old presentations carried.
 */

// The transport is a parameter of `StockPicture`, so the plate can be rendered
// without a network by resolving the signed URL to a local stand-in.
vi.mock('@/lib/builderStockQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/builderStockQueries')>()),
  builderStockImageUrl: vi.fn(async () => 'https://example.test/elevation.jpg'),
}));

const image = (over: Partial<BuilderStockImage> = {}): BuilderStockImage => ({
  id: 'img-1',
  stock_item_id: 'item-1',
  source_stage: 'uploaded_document',
  source_reference: null,
  source_provider: null,
  source_page_url: null,
  external_url: null,
  storage_path: 'stock/item-1/elevation.jpg',
  content_type: 'image/jpeg',
  verification_status: 'source_supplied',
  confidence: 1,
  processing_status: 'ready',
  error_message: null,
  position: 0,
  /*
   * What `isDisplayableSourceImage` actually admits, and nothing less: the
   * role the server records for a card's leading picture, plus the measured
   * marketplace verdict. A fixture that skips either is not exercising the
   * production path — which is how this test failed three times before it
   * told the truth.
   */
  source_detail: {
    role: 'primary_property',
    marketplace_eligibility_state: 'eligible',
  },
  created_at: '2026-09-01T00:00:00Z',
  ...over,
} as BuilderStockImage);

const item = (over: Partial<BuilderStockItem> = {}): BuilderStockItem => ({
  id: 'item-1',
  organisation_id: 'org-1',
  upload_id: null,
  first_upload_id: null,
  created_by_builder_user_id: null,
  builder_project_id: null,
  builder_unit_id: null,
  external_reference: null,
  development_name: 'Havenwood Estate',
  project_name: null,
  address_line: '14 Yillowra Street',
  suburb: 'Traralgon',
  state: 'VIC',
  postcode: '3844',
  lot_number: '40',
  unit_number: null,
  bedrooms: 4,
  bathrooms: 2,
  car_spaces: 2,
  property_type: 'House',
  land_size_sqm: 512,
  building_size_sqm: null,
  primary_image_id: 'img-1',
  images: [image()],
  availability: 'available',
  ...over,
} as unknown as BuilderStockItem);

function draw(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const plate = (over: Partial<BuilderStockItem> = {}) => (
  <StockPlate
    item={item(over)}
    saving={false}
    onAvailabilityChange={() => {}}
    onRemoved={() => {}}
  />
);

describe('the stock plate draws the property', () => {
  it('renders an image for a property that has one', async () => {
    // THE DEFECT. Before this, `grep -c "<img" BuilderStockList.tsx` was 0.
    const { container } = draw(plate());
    const drawn = await vi.waitFor(() => {
      const found = container.querySelectorAll('img');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect([...drawn].some((el) => el.getAttribute('src')?.includes('elevation'))).toBe(true);
  });

  it('names the property in the picture’s accessible name, not the file', async () => {
    draw(plate());
    const img = await screen.findByRole('img', { name: /Yillowra/i });
    expect(img).toBeTruthy();
  });

  it('draws no image, and says so, where the property has none', () => {
    const { container } = draw(plate({ primary_image_id: null, images: [] }));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText(/No picture found yet/i)).toBeTruthy();
  });
});

describe('the plate keeps every fact the table row carried', () => {
  it('states the address, the price and the configuration', () => {
    draw(plate());
    expect(screen.getAllByText(/Yillowra Street/).length).toBeGreaterThan(0);
    // The ruled schedule the icon chips replaced. It adds land and the home
    // size, which the chips left out entirely, and the labels are words
    // rather than the abbreviations a four-cell strip could afford.
    for (const key of ['Price', 'Bedrooms', 'Bathrooms', 'Car spaces', 'Home', 'Land']) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    expect(screen.getByText('512 m²')).toBeTruthy();
  });

  it('dashes a configuration value the record does not state', () => {
    // A dash in a cell whose key is drawn beside it is unambiguous; the
    // "name an absence" rule binds a fixed grid with no visible key.
    draw(plate({ land_size_sqm: null, car_spaces: null }));
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('states a missing price in words rather than drawing an empty figure', () => {
    // Price on application is a real state for a stock row, and the rule is
    // about the FIGURE slot: `splitPriceLine(null)` answers an em dash, and a
    // 1.7rem em dash in a title block's leading field is the broken-page
    // reading this avoids. So: the words are present AND nothing is drawn in
    // the price figure's own class.
    const { container } = draw(plate());
    expect(screen.getByText(/On application/i)).toBeTruthy();
    expect(container.querySelectorAll('.bd-spec-price')).toHaveLength(0);
  });

  it('prints the offer as the title block’s leading field', () => {
    const { container } = draw(plate({ price_display: 'From $749,000' } as never));
    // The figure and its qualifier, split but never reformatted: "From"
    // is a different offer from "$749,000" and both are drawn.
    expect(container.querySelector('.bd-spec-price')?.textContent).toBe('From $749,000');
  });

  it('carries the house size and the estate, which the row never drew', () => {
    // Two facts the record holds that no presentation on this page showed:
    // `building_size_sqm` (the marketplace card has always drawn it) and
    // `development_name`, which `stockItemTitle` deliberately leaves out.
    draw(plate({ building_size_sqm: 174 } as never));
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.getByText('174 m²')).toBeTruthy();
    expect(screen.getByText(/Havenwood Estate/)).toBeTruthy();
  });

  it('does not repeat the estate where the title already carries it', () => {
    // A title falls back to the estate name when the row states no address,
    // and an eyebrow repeating the line beneath it is the width spent twice.
    const { container } = draw(
      plate({ address_line: null, lot_number: null, suburb: null } as never),
    );
    // Scoped to the identity block: the Remove control carries the property's
    // name in its own screen-reader text, which is not a second heading.
    const identity = container.querySelector('.builder-stock-list-property');
    expect(identity?.textContent).toContain('Havenwood Estate');
    expect(identity?.querySelector('.bd-plate-eyebrow')?.textContent)
      .not.toContain('Havenwood');
  });
});

/*
 * The true DOM, written out for the visual check. The harness that designed
 * this page was hand-written markup; this is what the component actually
 * emits, so the screenshot is of the real thing.
 */
describe('dom capture', () => {
  const out = process.env.STOCK_PLATE_DOM_OUT;
  it('writes the rendered markup when asked', async () => {
    if (!out) {
      expect(true).toBe(true);
      return;
    }
    const { container } = draw(
      <ul className="bd-plate-list">
        {/* A priced row, a "From" row and an unpriced one — the three price
            states production actually holds — plus a property with no
            picture, because that is the state the sheet must not look
            broken in. */}
        {plate({ price_display: '$889,550', building_size_sqm: 174 } as never)}
        {plate({ id: 'item-2', lot_number: '41', address_line: '16 Yillowra Street',
                 bedrooms: 3, car_spaces: 1, land_size_sqm: 448,
                 price_display: 'From $749,000 fixed price, house and land',
                 building_size_sqm: 211 } as never)}
        {plate({ id: 'item-3', lot_number: '58', address_line: '7 Marloo Court',
                 development_name: 'Thornhill Gardens', suburb: 'Officer',
                 postcode: '3809', land_size_sqm: null,
                 bedrooms: null, bathrooms: null, car_spaces: null,
                 primary_image_id: null, images: [] })}
        {/* The reported defect, and the way out of it: a dual-key brochure
            states two sets of figures, so the extraction stated none, and the
            builder has stated three of them by hand. */}
        {plate({ id: 'item-4', lot_number: '324', address_line: '12 Dapple Avenue',
                 development_name: 'Palomino Estate', suburb: 'Armstrong Creek',
                 postcode: '3217', price_display: '$863,850 *',
                 bedrooms: 4, bathrooms: 3, car_spaces: 2,
                 building_size_sqm: null, land_size_sqm: 350,
                 manual_stats: {
                   values: { bedrooms: 4, bathrooms: 3, car_spaces: 2 },
                   recorded_at: '2026-09-13T02:00:00Z', recorded_by: 'u1',
                 },
                 stated_bedrooms: null, stated_bathrooms: null,
                 stated_car_spaces: null } as never)}
      </ul>,
    );
    /*
       Awaited, because the signed URL arrives from an effect: capturing
       synchronously writes the LOADING state, which is what the first
       attempt did — a sheet of spinners rendered instead of houses.
    */
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.bd-plate-frame img').length).toBeGreaterThan(0);
    });
    writeFileSync(join(process.cwd(), out), container.innerHTML, 'utf8');
    expect(container.querySelectorAll('.bd-plate').length).toBe(4);
  });
  afterAll(() => { /* nothing to tear down */ });
});
