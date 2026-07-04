# Command Reference Card

## Quick Commands

### Setup (First Time Only)
```bash
npm run local-gov:autonomous:setup
```

### Monitoring Commands

| Command | Interval | Mode | Ideal For |
|---------|----------|------|-----------|
| `npm run local-gov:autonomous:polling` | 30s | Normal | Standard use |
| `npm run local-gov:autonomous:polling:arnona` | 30s | Normal | Arnona specifically |
| `npm run local-gov:autonomous:polling:fast` | 15s | Normal | Urgent/peak hours |
| `npm run local-gov:autonomous:polling:silent` | 30s | Quiet | Background jobs |

### Custom Execution

```bash
# Custom interval (milliseconds) and runtime (minutes)
npm run local-gov:autonomous:polling -- --interval 45 --max-runtime 120

# Disable sounds
npm run local-gov:autonomous:polling -- --disable-sound

# Dry run (don't book)
npm run local-gov:autonomous:polling -- --dry-run

# Skip initial check
npm run local-gov:autonomous:polling -- --skip-first-check

# No visual alerts
npm run local-gov:autonomous:polling -- --quiet

# Don't auto-book (just alert)
npm run local-gov:autonomous:polling -- --no-auto-book

# Specific category
npm run local-gov:autonomous:polling -- --category other

# Combined example
npm run local-gov:autonomous:polling -- --interval 60 --category arnona --disable-sound --max-runtime 480
```

## Option Summary

| Option | Values | Default | Purpose |
|--------|--------|---------|---------|
| `--interval` | 15000-300000 ms | 30000 | Polling interval |
| `--heartbeat` | 1-10 | 5 | Log every N checks |
| `--max-retries` | 3-50 | 8 | Retry attempts |
| `--max-runtime` | 1-10000 min | 120 | Max duration |
| `--category` | string | arnona | Service category |
| `--disable-sound` | flag | false | No audio alerts |
| `--quiet` | flag | false | No visual output |
| `--skip-first-check` | flag | false | Skip initial check |
| `--no-auto-book` | flag | false | No auto-booking |
| `--dry-run` | flag | false | Test mode |

## Environment Variables

### Recommended (Use via setup wizard)
```bash
APPT_LOGIN_USER=username
APPT_LOGIN_PASS=password
APPT_OTP=123456
APPT_FULL_NAME="Name"
APPT_ID=12345
APPT_PHONE=0501234567
APPT_EMAIL=email@example.com
```

### Advanced
```bash
POLLING_INTERVAL_MS=30000
MAX_RETRIES=8
MAX_RUNTIME_MINUTES=120
DISABLE_ALERT_SOUND=false
TEL_AVIV_APPOINTMENT_PUBLIC_URL="https://..."
APPT_CATEGORY=arnona
APPT_NOTES="Message"
```

## Files

| File | Purpose |
|------|---------|
| `tmp/booking-creds.json` | Saved credentials ⚠️ KEEP PRIVATE |
| `tmp/booking-config.json` | Configuration preferences |
| `02_backend/scripts/run_autonomous_booking_with_polling.js` | Main agent |
| `02_backend/scripts/setup-autonomous-booking.js` | Setup wizard |

## Keyboard Shortcuts

| Key | Action |
|------|--------|
| `Ctrl+C` | Stop monitoring |
| `Enter` | (in setup) Use default/skip |

## Status Indicators

| Indicator | Meaning |
|-----------|---------|
| 🔵 | Checking (no change from last check) |
| 🟢 | SLOTS FOUND! (immediate action) |
| ⚠️ | Warning/retry attempt |
| ✗ | Error (check logs) |
| ✅ | Success/completion |
| 🚀 | Auto-booking started |
| 🎯 | Target detected |

## Audio Alerts

| Sound | Trigger |
|-------|---------|
| Triple beep 🔊🔊🔊 | Slots detected |
| Can be disabled with: `--disable-sound` |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success/normal exit |
| 1 | Setup failed/error |
| 2 | Invalid arguments |

## Performance Tips

### Faster Detection
```bash
npm run local-gov:autonomous:polling:fast
# 15s intervals = detect slots ~15s after posting
```

### Resource Efficient
```bash
npm run local-gov:autonomous:polling:silent -- --interval 120
# Checks every 2 min, no CPU overhead
```

### Long-Term Monitoring
```bash
npm run local-gov:autonomous:polling -- --max-runtime 1440 --interval 60
# 24-hour run, checks every 60s
```

## Common Workflows

### "I want slots ASAP"
```bash
npm run local-gov:autonomous:polling:fast
# 15s checks, audio alerts, auto-book ON
```

### "Monitor in background"
```bash
npm run local-gov:autonomous:polling:silent
# No output, silent running
```

### "Test before real run"
```bash
npm run local-gov:autonomous:polling -- --dry-run --max-runtime 5
# 5 min test, don't actually book
```

### "24/7 Continuous"
```bash
# Create batch file (monitor.bat):
@echo off
:loop
npm run local-gov:autonomous:polling:silent -- --max-runtime 480
goto loop
```

### "Multiple Services"
```bash
# Terminal 1
npm run local-gov:autonomous:polling:arnona

# Terminal 2  
npm run local-gov:autonomous:polling -- --category other
```

## Database Queries

### See all slot detections
```sql
SELECT * FROM government_requests 
WHERE description LIKE '%SLOTS%' 
ORDER BY created_at DESC;
```

### See all bookings
```sql
SELECT * FROM government_requests 
WHERE description LIKE '%booking%' 
ORDER BY created_at DESC;
```

### See session history
```sql
SELECT * FROM government_requests 
WHERE user_id = 'cli-autonomous-booking'
ORDER BY created_at DESC;
```

## Troubleshooting Quick Fixes

| Problem | Fix |
|---------|-----|
| Credentials not found | `npm run local-gov:autonomous:setup` |
| No audio | Remove `--disable-sound` |
| Website unreachable | Check internet, try `--interval 60` |
| High CPU | Use `--interval 120` |
| CAPTCHA loop | Solve manually or check credentials |

## Documentation Links

- 📖 Quick Start: [AUTONOMOUS_BOOKING_QUICKSTART.md](./AUTONOMOUS_BOOKING_QUICKSTART.md)
- 📚 Full Guide: [AUTONOMOUS_BOOKING_GUIDE.md](./AUTONOMOUS_BOOKING_GUIDE.md)  
- 🚀 Walkthrough: [END_TO_END_BOOKING_WALKTHROUGH.md](./END_TO_END_BOOKING_WALKTHROUGH.md)
- 📋 Summary: [AUTONOMOUS_BOOKING_SUMMARY.md](./AUTONOMOUS_BOOKING_SUMMARY.md)

---

**Print this card for quick reference!**
