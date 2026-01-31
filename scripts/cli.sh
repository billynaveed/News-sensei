#!/bin/bash

# Lead Intelligence CLI Tool
# Usage: ./scripts/cli.sh <command> [args]

API_BASE="http://localhost:5000/api"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

COMMAND="${1:-help}"

case "$COMMAND" in
    leads|saved)
        ./scripts/leads.sh saved
        ;;

    new)
        ./scripts/leads.sh new
        ;;

    dismissed)
        ./scripts/leads.sh dismissed
        ;;

    all)
        ./scripts/leads.sh all
        ;;

    stats)
        echo -e "${BOLD}${CYAN}📊 Lead Statistics${NC}\n"

        # Fetch all leads and calculate stats
        LEADS=$(curl -s "$API_BASE/leads")

        echo "$LEADS" | jq -r '
            (group_by(.status) | map({key: .[0].status, value: length}) | from_entries) as $byStatus |
            (group_by(.priorityLevel) | map({key: .[0].priorityLevel, value: length}) | from_entries) as $byPriority |
            (now | strftime("%Y-%m-%d")) as $today |

            "Total Leads: \u001b[1;36m" + (length | tostring) + "\u001b[0m" +
            "\n\nBy Status:" +
            "\n  • New: \u001b[0;32m" + (($byStatus.new // 0) | tostring) + "\u001b[0m" +
            "\n  • Reviewed: \u001b[0;34m" + (($byStatus.reviewed // 0) | tostring) + "\u001b[0m" +
            "\n  • Saved: \u001b[0;35m" + (($byStatus.saved // 0) | tostring) + "\u001b[0m" +
            "\n  • Contacted: \u001b[0;33m" + (($byStatus.contacted // 0) | tostring) + "\u001b[0m" +
            "\n  • Dismissed: \u001b[0;31m" + (($byStatus.dismissed // 0) | tostring) + "\u001b[0m" +
            "\n\nBy Priority:" +
            "\n  • 🔴 High: \u001b[0;31m" + (($byPriority.high // 0) | tostring) + "\u001b[0m" +
            "\n  • 🟡 Medium: \u001b[0;33m" + (($byPriority.medium // 0) | tostring) + "\u001b[0m" +
            "\n  • 🟢 Low: \u001b[0;32m" + (($byPriority.low // 0) | tostring) + "\u001b[0m"
        '
        echo ""
        ;;

    scan)
        echo -e "${BOLD}${CYAN}🔍 Starting news scan...${NC}\n"
        RESULT=$(curl -s -X POST "$API_BASE/scan")
        SCAN_ID=$(echo "$RESULT" | jq -r '.scanId')
        echo -e "${GREEN}Scan started with ID: $SCAN_ID${NC}"
        echo -e "${YELLOW}Check progress at: http://localhost:5000${NC}\n"
        ;;

    recent)
        echo -e "${BOLD}${CYAN}📰 Recent Scan Logs${NC}\n"
        curl -s "$API_BASE/scan-logs" | jq -r '.[:5] | .[] |
            "\u001b[1;36m" + (.createdAt | split("T")[0]) + " " + (.createdAt | split("T")[1] | split(".")[0]) + "\u001b[0m" +
            "\n  Articles: " + (.articlesScanned | tostring) +
            " | New Leads: \u001b[0;32m" + (.newLeads | tostring) + "\u001b[0m" +
            " | Duplicates: " + (.duplicatesSkipped | tostring) +
            " | Duration: " + ((.durationMs / 1000) | tostring) + "s" +
            "\n"
        '
        ;;

    help|*)
        echo -e "${BOLD}${CYAN}Lead Intelligence CLI${NC}\n"
        echo "Available commands:"
        echo ""
        echo -e "  ${GREEN}leads${NC}, ${GREEN}saved${NC}    - Show saved leads (default)"
        echo -e "  ${GREEN}new${NC}              - Show new leads"
        echo -e "  ${GREEN}dismissed${NC}        - Show dismissed leads"
        echo -e "  ${GREEN}all${NC}              - Show all leads"
        echo -e "  ${GREEN}stats${NC}            - Show lead statistics"
        echo -e "  ${GREEN}scan${NC}             - Start a new scan"
        echo -e "  ${GREEN}recent${NC}           - Show recent scan logs"
        echo -e "  ${GREEN}help${NC}             - Show this help message"
        echo ""
        echo "Usage:"
        echo -e "  ${CYAN}npm run cli <command>${NC}"
        echo -e "  ${CYAN}./scripts/cli.sh <command>${NC}"
        echo ""
        ;;
esac
