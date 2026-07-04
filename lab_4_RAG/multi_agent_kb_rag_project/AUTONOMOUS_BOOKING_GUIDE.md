# Autonomous Appointment Booking with Continuous Slot Monitoring

## Overview

The autonomous booking system continuously monitors for available appointment slots and automatically books when slots become available, specifically optimized for Arnona (property tax) appointments.

**Features:**
- ✅ One-time credential collection (saved for future use)
- ✅ Continuous polling for slot availability  
- ✅ Visual and audio alerts when slots found
- ✅ Automatic booking attempt on slot detection
- ✅ Support for OTP and CAPTCHA detection
- ✅ Configurable polling intervals
- ✅ Persistent session management
- ✅ Error recovery with exponential backoff

## Quick Start

### 1. First Run - Interactive Setup (Recommended)

This will ask for your credentials **once**, save them, and start the autonomous loop:

```bash
npm run local-gov:autonomous:polling:arnona
```

You'll be prompted for:
- 📧 Login username
- 🔐 Login password  
- 🔑 OTP code (if required)
- 👤 Full name
- 🆔 ID number
- 📞 Phone number
- ✉️ Email address

Credentials are saved to `tmp/booking-creds.json` and will be reused automatically on subsequent runs.

### 2. Subsequent Runs - Fully Autonomous

After initial setup, just run:

```bash
npm run local-gov:autonomous:polling:arnona
```

The system will use saved credentials automatically.

### 3. Run Variants

**Fast polling (15-second intervals):**
```bash
npm run local-gov:autonomous:polling:fast
```

**Silent mode (no sounds/visual):**
```bash
npm run local-gov:autonomous:polling:silent
```

**Custom configuration:**
```bash
npm run local-gov:autonomous:polling -- --category arnona --interval 30 --max-runtime 120
```

## Configuration Options

### Command-line Arguments

```bash
npm run local-gov:autonomous:polling -- [options]

Options:
  --category CATEGORY         Appointment category (default: arnona)
  --interval MILLISECONDS     Polling interval in ms (default: 30000)
  --heartbeat NUMBER          Log heartbeat every N checks (default: 5)
  --max-retries NUMBER        Max retry attempts on failure (default: 8)
  --max-runtime MINUTES       Max runtime in minutes (default: 120)
  --disable-sound             Disable alert sounds
  --quiet                     Disable visual alerts
  --skip-first-check          Skip initial check
  --no-auto-book              Disable automatic booking on slots
  --dry-run                   Run in dry mode (don't actually book)
```

### Environment Variables

```bash
# Credentials
APPT_LOGIN_USER=your_username
APPT_LOGIN_PASS=your_password
APPT_OTP=123456

# Applicant info
APPT_FULL_NAME="John Doe"
APPT_ID=123456789
APPT_PHONE=0501234567
APPT_EMAIL=john@example.com

# Behavior
POLLING_INTERVAL_MS=30000
MAX_RETRIES=8
MAX_RUNTIME_MINUTES=120
DISABLE_ALERT_SOUND=false

# Category
APPT_CATEGORY=arnona
APPT_NOTES="arnona appointment - check slots and schedule"
```

## Usage Patterns

### Pattern 1: One-Time Setup, Then Continuous Monitoring

```bash
# First time - interactive, saves credentials
npm run local-gov:autonomous:polling:arnona

# Next time - fully autonomous using saved credentials
npm run local-gov:autonomous:polling:arnona
npm run local-gov:autonomous:polling:arnona  # Keep it running
```

### Pattern 2: Pre-set All Environment Variables

```bash
# Windows PowerShell
$Env:APPT_LOGIN_USER = "username"
$Env:APPT_LOGIN_PASS = "password"
$Env:APPT_OTP = "123456"
$Env:APPT_FULL_NAME = "Your Name"
$Env:APPT_ID = "12345"
$Env:APPT_PHONE = "0501234567"
$Env:APPT_EMAIL = "your@email.com"

npm run local-gov:autonomous:polling:arnona
```

```bash
# Linux/Mac
export APPT_LOGIN_USER="username"
export APPT_LOGIN_PASS="password"
export APPT_OTP="123456"
export APPT_FULL_NAME="Your Name"
export APPT_ID="12345"
export APPT_PHONE="0501234567"
export APPT_EMAIL="your@email.com"

npm run local-gov:autonomous:polling:arnona
```

### Pattern 3: Fast Slot Checking During Business Hours

```bash
# Check every 15 seconds in business hours
npm run local-gov:autonomous:polling:fast -- --max-runtime 480
```

### Pattern 4: Silent Monitoring (for background/cron jobs)

```bash
npm run local-gov:autonomous:polling:silent -- --interval 120 --max-runtime 1440
```

## How It Works

### Polling Loop

```
1. Check credenti als (load from file or ask)
   ↓
2. Initial slot check (unless --skip-first-check)
   ↓
3. Polling loop (every N seconds):
   a. Check booking website
   b. Detect slot availability
   c. If slots detected → ALERT + attempt booking
   d. If booked → STOP
   e. If error → retry with backoff
   f. If max-runtime reached → STOP
   g. Otherwise → sleep and repeat
```

### Slot Detection Algorithm

The system analyzes page content for:

**Positive indicators (slots available):**
- "available slot", "slots available"
- "זמינות" (Hebrew: availability)
- "תור פנוי" (Hebrew: free slot)
- "can schedule", "ready to book"

**Negative indicators (no slots):**
- "no available", "fully booked"
- "אין תורים" (Hebrew: no slots)
- "closed", "unavailable"

**Confidence scoring:** 0-100% based on signal strength

### Alert System

**Visual Alerts:**
- 🔵 Heartbeat (every N checks)
- 🟢 SLOTS FOUND (with confidence)
- ⚠️ Warnings
- ✗ Errors

**Audio Alerts:**
- Triple beep when slots detected
- System sounds (Windows/Mac/Linux compatible)
- Can be disabled with `--disable-sound`

### Automatic Booking

When slots are detected:
1. Alert user immediately
2. Load saved credentials
3. Launch browser automation
4. Auto-login with saved username/password
5. Handle OTP if required
6. Fill out appointment form
7. Submit booking
8. Stop monitoring

If CAPTCHA is encountered, user intervention is required.

## Credential Management

### Saving Credentials

Credentials are saved to: `tmp/booking-creds.json`

This file is **local only** (never committed to Git). It contains:
```json
{
  "loginUsername": "your_username",
  "loginPassword": "your_password", 
  "otpCode": "123456",
  "savedAt": "2026-03-19T21:20:51.244Z"
}
```

⚠️ **Security Note:** Store this file securely. The credentials are in plaintext.

### Clearing Saved Credentials

```bash
# Manual approach - delete the file
rm tmp/booking-creds.json  # Linux/Mac
del tmp\booking-creds.json # Windows
```

### Updating Credentials

Just run the script again in TTY mode - it will prompt for new credentials:
```bash
npm run local-gov:autonomous:polling:arnona
```

## Monitoring Output

### Success Scenario
```
╔════════════════════════════════════════════════════════════════════╗
║     🤖 AUTONOMOUS BOOKING WITH CONTINUOUS SLOT MONITORING        ║
╚════════════════════════════════════════════════════════════════════╝

📋 Configuration:
   Category: arnona
   Website: https://www.tel-aviv.gov.il/Contact/Pages/Apointments.aspx
   Polling every 30s
   Max runtime: 120 minutes
   Auto-book on slots: YES

⏳ Starting polling loop (Ctrl+C to stop)...
🔵 [21:25:30] Check #1 - No slots (negative-signals-found)
🔵 [21:26:00] Check #2 - No slots (negative-signals-found)
🟢 [21:26:30] SLOTS DETECTED (85% confidence)  ← ← ← ALERT!
🚀 [21:26:31] Starting autonomous booking attempt...
✅ [21:26:55] BOOKING SUBMITTED SUCCESSFULLY!

═══════════════════════════════════════════════════════════════════
📊 SESSION SUMMARY:
   Checks performed: 3
   Slots found: 1
   Last slot found: 2026-03-19T21:26:30.000Z
   Runtime: 0m 26s
═══════════════════════════════════════════════════════════════════
```

### Failure Scenario (requiring intervention)
```
🔵 [21:30:00] Check #5 - No slots (unclear)
⚠ [21:30:31] Check failed (1/8): Network timeout
⚠ [21:31:00] Check failed (2/8): ECONNREFUSED 
🟢 [21:31:30] SLOTS DETECTED (72% confidence)
🚀 [21:31:31] Starting autonomous booking attempt...
⚠ [21:32:00] Booking attempt resulted in state: AWAITING_LOGIN
⚠ Human intervention needed - check terminal for prompts
```

## Troubleshooting

### Issue: "Non-interactive terminal - cannot collect credentials"

**Solution:** Set environment variables or provide credentials file:
```bash
$Env:APPT_LOGIN_USER = "username"
$Env:APPT_LOGIN_PASS = "password"
npm run local-gov:autonomous:polling:arnona
```

### Issue: "Check failed - Network timeout" repeated

**Solution:** 
- Increase polling interval: `--interval 60`
- Check internet connection
- Website might be down

### Issue: Credentials not being loaded

**Solution:** 
1. Delete and recreate: `rm tmp/booking-creds.json`
2. Re-run in TTY mode to re-enter credentials
3. Verify file exists: `ls tmp/booking-creds.json`

### Issue: "CAPTCHA detected" - booking stops

**Solution:**
- CAPTCHA requires manual intervention
- Browser window will open - solve CAPTCHA manually
- System will auto-continue after CAPTCHA

### Issue: No audio alerts

**Solution:**
- Check system sound is enabled
- Try: `--disable-sound false` to force enable
- Check if not in quiet mode: `--quiet`

## Advanced Usage

### Continuous 24/7 Monitoring

```bash
# Monitor for 24 hours, check every 2 minutes
npm run local-gov:autonomous:polling:arnona -- --interval 120 --max-runtime 1440
```

### Multiple Categories

Run separate instances:
```bash
# Terminal 1 - Arnona
npm run local-gov:autonomous:polling:arnona

# Terminal 2 - Other services  
npm run local-gov:autonomous:polling -- --category other --interval 60
```

### Scripted/Cron Execution

```bash
#!/bin/bash
# monitor.sh - Run daily at 08:00

export APPT_LOGIN_USER="username"
export APPT_LOGIN_PASS="password"

cd /path/to/lab_4_RAG/multi_agent_kb_rag_project
npm run local-gov:autonomous:polling:arnona -- \
  --interval 30 \
  --max-runtime 540 \
  --quiet \
  --disable-sound
```

## Database Tracking

All attempts are logged to the database:
- Slot discoveries → `government_requests` (status: `approved`)
- Booking submissions → `government_requests` (status: `approved`)
- Session failures → `government_requests` (status: `error`)

Query recent activity:
```sql
SELECT * FROM government_requests 
WHERE user_id = 'cli-autonomous-booking'
ORDER BY created_at DESC
LIMIT 20;
```

## Support

For issues or questions:
1. Check logs in database
2. Run with `--verbose` for detailed output
3. Check credentials file: `cat tmp/booking-creds.json`
4. Verify website is accessible: `curl https://www.tel-aviv.gov.il/...`

---

**Safe and secure autonomous appointment booking!** 🤖🎯
