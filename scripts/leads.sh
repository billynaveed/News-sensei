#!/bin/bash

# Lead Intelligence CLI Tool
# Usage: ./scripts/leads.sh [status]

API_BASE="http://localhost:5000/api"

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

STATUS="${1:-saved}"

echo -e "${BOLD}${CYAN}📋 Lead Intelligence - ${STATUS^} Leads${NC}\n"

# Fetch leads and filter by status
if [ "$STATUS" = "all" ]; then
    LEADS=$(curl -s "$API_BASE/leads" | jq '[.[]]')
else
    LEADS=$(curl -s "$API_BASE/leads" | jq --arg status "$STATUS" '[.[] | select(.status == $status)]')
fi

COUNT=$(echo "$LEADS" | jq 'length')

if [ "$COUNT" -eq 0 ]; then
    echo -e "${YELLOW}No $STATUS leads found.${NC}"
    exit 0
fi

echo -e "${GREEN}Found $COUNT $STATUS lead(s)${NC}\n"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Display each lead
echo "$LEADS" | jq -r '.[] |
    "\n\u001b[1;36m" + .headline + "\u001b[0m" +
    "\n\u001b[0;35m│\u001b[0m Companies: " + (.companyNames | join(", ")) +
    (if .companyDescription then "\n\u001b[0;35m│\u001b[0m   \u001b[0;90m" + .companyDescription + "\u001b[0m" else "" end) +
    "\n\u001b[0;35m│\u001b[0m People: " + (if .founderNames | length > 0 then (.founderNames | join(", ")) else "N/A" end) +
    "\n\u001b[0;35m│\u001b[0m Region: " + .region +
    "\n\u001b[0;35m│\u001b[0m Priority: " +
        (if .priorityLevel == "high" then "\u001b[0;31m🔴 HIGH\u001b[0m"
         elif .priorityLevel == "medium" then "\u001b[0;33m🟡 MEDIUM\u001b[0m"
         else "\u001b[0;32m🟢 LOW\u001b[0m" end) +
        " (Score: " + (.priorityScore | tostring) + ")" +
    "\n\u001b[0;35m│\u001b[0m Summary: " + .aiSummary +
    "\n\u001b[0;35m│\u001b[0m URL: \u001b[0;34m" + .sourceUrl + "\u001b[0m" +
    "\n\u001b[0;35m│\u001b[0m ID: \u001b[0;90m" + .id + "\u001b[0m" +
    "\n\u001b[0;35m└─────────────────────────────────────────────────────────────────────\u001b[0m"
'

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}Total: $COUNT ${STATUS} lead(s)${NC}"
