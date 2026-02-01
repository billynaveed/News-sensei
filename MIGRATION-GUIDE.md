# Saved Leads Migration Guide

## Overview

The saved leads system has been refactored from a simple status flag to a dedicated database table with enhanced metadata. This guide explains how to migrate your existing saved leads.

## What Changed?

**Before:** Saved leads were just `leads` table entries with `status: "saved"`

**After:** Saved leads are stored in a dedicated `saved_leads` table with additional fields:
- `founderLinkedInUrl` - LinkedIn profile URL
- `founderBio` - Biography and background
- `companyDescription` - Company details
- `notes` - Private user notes
- `researchData` - JSON field for future data

## Migration Steps

### Automatic Migration (Recommended)

The migration runs automatically when you start the development server:

```bash
# 1. First, push the new database schema
npm run db:push
# When prompted, select: "+ saved_leads create table"

# 2. Start the development server
npm run dev
# Migration will run automatically on startup
```

You'll see a message in the console:
```
Migrated X saved leads to new table
```

### Manual Migration (If Needed)

If you need to run the migration manually:

```bash
# Option 1: Run the migration script directly
npm run migrate:saved-leads

# Option 2: Trigger via API endpoint
curl -X POST http://localhost:5000/api/migrate-saved-leads
```

## What Gets Migrated?

The migration script will:
1. Find all leads with `status: "saved"` in the `leads` table
2. Create corresponding entries in the `saved_leads` table
3. Skip leads that are already in the `saved_leads` table (idempotent)
4. Log the results: `{ total, migrated, skipped, errors }`

**Important:** The original leads are NOT deleted or modified. They keep their `status: "saved"` for backward compatibility.

## After Migration

Once migrated, you'll see your saved leads in the new `/saved-leads` page with:
- All the original lead data
- Empty fields for LinkedIn, bio, company description, and notes (ready for you to fill in)
- Expandable sections for adding detailed research

## Troubleshooting

### "Table saved_leads does not exist"
Run `npm run db:push` first to create the table.

### "No saved leads to migrate"
Either:
- You don't have any saved leads yet
- They've already been migrated (check the `/saved-leads` page)

### Migration runs every time I start the server
This is normal! The migration is idempotent - it skips leads that are already migrated, so it won't create duplicates.

## Backward Compatibility

The system maintains backward compatibility:
- Saving a lead creates BOTH a `saved_leads` entry AND sets `status: "saved"` in the `leads` table
- Removing from saved deletes from `saved_leads` AND sets `status: "reviewed"` in the `leads` table
- Old code that checks `status === "saved"` will continue to work

## Need Help?

If you encounter any issues, check the server logs for detailed error messages.
