# Private Banker Lead Intelligence Tool - Design Guidelines

## Design Approach
**Selected System:** Material Design 3 with Financial Services Professional adaptation
**Rationale:** Information-dense B2B tool requiring clarity, data hierarchy, and professional credibility. Inspired by Bloomberg Terminal's information architecture + Linear's clean typography + Stripe Dashboard's restraint.

## Typography System
- **Primary Font:** Inter (via Google Fonts CDN)
- **Headings:** font-bold, tracking-tight
  - H1: text-3xl lg:text-4xl
  - H2: text-2xl lg:text-3xl
  - H3: text-xl lg:text-2xl
- **Body:** text-base, font-normal, leading-relaxed
- **Data/Metrics:** font-mono for numerical values, tabular-nums
- **Labels:** text-sm, font-medium, uppercase tracking-wide

## Layout & Spacing System
**Spacing Primitives:** Use Tailwind units: 2, 4, 6, 8, 12, 16, 24
- Component padding: p-4 or p-6
- Section spacing: py-12 lg:py-16
- Card gaps: gap-4 or gap-6
- Container: max-w-7xl mx-auto px-4

## Core Components

### Dashboard Layout
- **Sidebar Navigation:** Fixed left sidebar (w-64), collapsible on mobile
- **Main Content Area:** Flex-grow with max-w-6xl centering
- **Top Bar:** Stats overview with key metrics (total leads, today's alerts, pending reviews)

### Lead Cards
- Elevated cards with subtle shadow
- Header: Company name + wealth event type badge
- Body: Founder name, event description, source, date
- Footer: Action buttons (View Details, Mark Reviewed, Export)
- Status indicators with badges (New, Reviewed, High Priority)

### Data Tables
- Sortable columns with clear headers
- Alternating row backgrounds for readability
- Fixed header on scroll
- Inline actions (view, export, archive)
- Pagination at bottom

### Filtering System
- Sticky filter bar at top of content
- Multi-select dropdowns: Region, Event Type, Date Range, Source
- Clear filters button
- Active filter chips displayed

### Alert Settings Panel
- Form sections with clear labels
- Toggle switches for notification preferences
- Email frequency selector (Hourly, Daily, Weekly)
- Preview section showing sample alert format

## Component Library
**Icons:** Heroicons (via CDN)
**Buttons:** 
- Primary: Solid background, medium weight text
- Secondary: Outline with transparent fill
- Sizes: py-2 px-4 (base), py-3 px-6 (large)

**Badges:** Rounded-full px-3 py-1 text-xs, status-specific treatments

**Cards:** Rounded-lg with p-6, subtle border

**Forms:** 
- Inputs: Rounded-md border with focus ring
- Labels: Block mb-2 text-sm font-medium
- Helper text: text-xs text-muted

**Modals:** Centered overlay with backdrop blur, max-w-2xl

## Page Structures

### Login/Landing
- Split-screen layout (50/50)
- Left: Login form with centered vertical alignment
- Right: Hero image showing professional financial workspace
- **Hero Image Description:** Modern office setting with multiple monitors displaying financial data dashboards, warm professional lighting, Singapore skyline visible through window

### Dashboard Home
- Three-column metric cards at top (Today's Leads | This Week | High Priority)
- Main feed: Chronological lead cards with infinite scroll
- Right sidebar: Recent activity log + Quick filters

### Lead Detail View
- Full-width header with company name and event summary
- Two-column layout: Left (Lead details, timeline) | Right (Source article preview, actions)
- Related leads section at bottom

### Settings Page
- Tab navigation: Account | Alerts | Integrations | API
- Form-based interface with save/cancel actions
- Success/error toast notifications

## Visual Hierarchy
- Use scale and weight for hierarchy, not excessive color
- Data emphasis through font-mono and bold weights
- Subtle dividers (border-gray-200) between sections
- Ample whitespace around dense information clusters

## Animations
**Minimal approach:**
- Card hover: subtle lift (translate-y-1)
- Loading states: Simple pulse on skeleton screens
- Page transitions: None (instant for data tool)
- Modal entrance: Fade-in only

**Images:**
- Hero image on landing/login page only
- No images in main dashboard (data-focused interface)