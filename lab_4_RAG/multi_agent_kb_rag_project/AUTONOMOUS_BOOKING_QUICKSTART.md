# 🤖 Autonomous Appointment Booking - Quick Start Guide

## What This Does

This system enables **fully autonomous appointment booking** for municipal services (specifically Arnona/tax payments) with:
- ✅ One-time credential setup
- ✅ Continuous slot monitoring
- ✅ Automatic alerts when appointments available
- ✅ Automatic booking when slots found
- ✅ No additional human intervention needed after setup

## Start Here - 3 Steps

### Step 1: Run Setup Wizard (Mandatory - One Time)

```bash
npm run local-gov:autonomous:setup
```

You'll be guided through entering:
- 🔐 Login credentials (saved locally, never shared)
- 👤 Your personal information
- ⚙️ Monitoring preferences

**Output:**
```
✅ Setup complete!
📊 Configuration:
   Category: arnona
   Polling every 30s
   Sound alerts: YES
   Auto-book: YES
```

### Step 2: Start Autonomous Monitoring

```bash
npm run local-gov:autonomous:polling:arnona
```

The system will now:
- Check for available slots every 30 seconds
- Stay running until slots found or timeout
- Alert you immediately when appointments available
- Automatically book when slots detected

**Output while running:**
```
🔵 Check #1 - No slots
🔵 Check #2 - No slots
🔵 Check #3 - No slots
🔵 Check #4 - No slots
🔵 Check #5 - No slots  ← Heartbeat
...
```

### Step 3: Wait for Alert! 🎯

When slots are found:
```
🟢 SLOTS DETECTED (87% confidence)
   ↓ [BEEP BEEP BEEP! 🔊]
   ✅ BOOKING SUBMITTED SUCCESSFULLY!
```

That's it! Your appointment is booked.

---

## Different Monitoring Modes

### 🏃 Fast Checking (15s intervals)
```bash
npm run local-gov:autonomous:polling:fast
```

### 🔇 Silent Mode (no sounds)
```bash
npm run local-gov:autonomous:polling:silent
```

### ⏱️ Long-term (24 hours)
```bash
npm run local-gov:autonomous:polling -- --max-runtime 1440
```

### 🎛️ Custom Configuration
```bash
npm run local-gov:autonomous:polling -- --interval 45 --max-runtime 480
```

---

## Key Details

### Where Credentials Are Saved
- **File:** `tmp/booking-creds.json`
- **Format:** Plain JSON (keep private!)
- **Reused:** Automatically on future runs
- **Update:** Run setup wizard again

### How Slots Are Detected
- Analyzes website content
- Looks for "available slot", "זמינות" (Hebrew)
- Scores confidence 0-100%
- Triggers at >50% confidence

### What Happens on Booking
1. Browser opens automatically
2. Auto-logs in with saved credentials
3. Handles OTP if required
4. Fills appointment form
5. Submits booking
6. System exits

---

## Documentation Files

| Document | Purpose |
|----------|---------|
| [AUTONOMOUS_BOOKING_GUIDE.md](./AUTONOMOUS_BOOKING_GUIDE.md) | Complete reference with all options |
| [END_TO_END_BOOKING_WALKTHROUGH.md](./END_TO_END_BOOKING_WALKTHROUGH.md) | Step-by-step walkthrough with scenarios |

---

## Troubleshooting

### ❓ "Non-interactive terminal"
- Run from PowerShell/Terminal, not from VS Code integrated terminal
- Or set env vars: `$Env:APPT_LOGIN_USER = "username"`

### ❓ "Website unreachable"
- Check internet connection
- Website might be temporarily down
- Try increasing polling interval: `--interval 60`

### ❓ "Credentials not found"
- Run setup wizard again
- File: `tmp/booking-creds.json` should exist

### ❓ "No slots found"
- Slots might not be available
- Keep monitoring running
- Try during different hours

### ❓ "CAPTCHA appeared"
- Solve it manually in browser that opens
- System auto-continues after CAPTCHA

---

## npm Scripts Reference

```bash
# Setup
npm run local-gov:autonomous:setup

# Monitoring (choose one)
npm run local-gov:autonomous:polling               # Standard (30s)
npm run local-gov:autonomous:polling:arnona        # Arnona preset
npm run local-gov:autonomous:polling:fast          # Fast (15s)
npm run local-gov:autonomous:polling:silent        # Silent mode

# With custom options
npm run local-gov:autonomous:polling -- --interval 45 --max-runtime 120
```

---

## Example Workflow

```bash
# Day 1 - Setup
npm run local-gov:autonomous:setup
# Follow prompts, save credentials

# Day 2 - Start Monitoring
npm run local-gov:autonomous:polling:arnona
# System runs continuously

# [System monitors and finds slots automatically]

# [Browser opens, booking happens automatically]

# System exits with success message
✅ BOOKING SUBMITTED SUCCESSFULLY!
```

---

## Files Created/Modified

✅ `02_backend/scripts/run_autonomous_booking_with_polling.js` - Main agent
✅ `02_backend/scripts/setup-autonomous-booking.js` - Setup wizard
✅ `package.json` - Added npm scripts
✅ `AUTONOMOUS_BOOKING_GUIDE.md` - Full documentation
✅ `END_TO_END_BOOKING_WALKTHROUGH.md` - Step-by-step guide

---

## Security Notes

⚠️ Credentials stored in plaintext in `tmp/booking-creds.json`
⚠️ Never commit credentials file to Git
⚠️ Never share credentials file
⚠️ Only run on trusted machines
⚠️ Delete file when no longer needed

---

## Next Steps

1. **Now:** `npm run local-gov:autonomous:setup`
2. **Then:** `npm run local-gov:autonomous:polling:arnona`
3. **Wait:** System monitors continuously
4. **Enjoy:** Automatic booking when slots available!

---

**Questions?** Check [END_TO_END_BOOKING_WALKTHROUGH.md](./END_TO_END_BOOKING_WALKTHROUGH.md)

**Full details?** Check [AUTONOMOUS_BOOKING_GUIDE.md](./AUTONOMOUS_BOOKING_GUIDE.md)

---

Happy booking! 🎯✨
