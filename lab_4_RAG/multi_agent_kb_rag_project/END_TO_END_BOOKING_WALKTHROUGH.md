# End-to-End Autonomous Appointment Booking 🤖📅

## Complete System Walkthrough

This guide demonstrates the **complete end-to-end flow** for setting up and running autonomous appointment booking for Arnona (property tax) appointments with continuous slot monitoring.

---

## Part 1: System Architecture

```
User Credentials
      ↓
┌─────────────────────────────────────────┐
│   Interactive Setup (One-Time)          │
│   • Collect username/password           │
│   • Collect OTP if needed               │
│   • Save to tmp/booking-creds.json      │
└─────────────────────────────────────────┘
      ↓
┌─────────────────────────────────────────┐
│   Autonomous Polling Loop (Repeats)     │
│   • Check every 30s (configurable)      │
│   • Detect slot availability            │
│   • Alert when slots found              │
│   • Auto-book if enabled                │
└─────────────────────────────────────────┘
      ↓
┌─────────────────────────────────────────┐
│   Database Logging                      │
│   • Slot discoveries → government_req   │
│   • Booking submissions → government_req│
│   • Session failures → error log        │
└─────────────────────────────────────────┘
```

---

## Part 2: Step-by-Step Execution

### **STEP 1: Initial Setup**

Choose ONE option:

#### **Option A: Guided Interactive Setup (Recommended)**

```bash
cd c:\Users\ADMIN\Desktop\Agentic_AI_2026\lab_4_RAG\multi_agent_kb_rag_project

npm run local-gov:autonomous:setup
```

This will guide you through:
1. ✅ Credential entry (username, password, OTP)
2. ✅ Applicant information (name, ID, phone, email)
3. ✅ Preferences (polling interval, alerts, auto-book)
4. ✅ Connection test
5. ✅ Summary and next steps

**Example Output:**
```
╔════════════════════════════════════════════════════════════════════╗
║        🤖 AUTONOMOUS APPOINTMENT BOOKING - SETUP WIZARD            ║
╚════════════════════════════════════════════════════════════════════╝

📋 CREDENTIAL SETUP
ℹ️  These will be saved locally and reused automatically.

Login username: john.doe
Login password: ••••••••
OTP code (if required, or press Enter): 123456

👤 APPLICANT INFORMATION
Full name: John Doe
ID number: 123456789
Phone number: 0501234567
Email address: john.doe@gmail.com

⚙️  PREFERENCES
Appointment category (default: arnona): arnona
Polling interval in seconds (default: 30): 30
Enable audio alerts? (y/n): y
Auto-book when slots found? (y/n): y

[Shows summary and saves files]

✅ Setup complete!
```

#### **Option B: Environment Variables**

Pre-set all variables, then run:

```bash
# PowerShell (Windows)
$Env:APPT_LOGIN_USER = "john.doe"
$Env:APPT_LOGIN_PASS = "password"
$Env:APPT_OTP = "123456"
$Env:APPT_FULL_NAME = "John Doe"
$Env:APPT_ID = "123456789"
$Env:APPT_PHONE = "0501234567"
$Env:APPT_EMAIL = "john@example.com"

cd c:\Users\ADMIN\Desktop\Agentic_AI_2026\lab_4_RAG\multi_agent_kb_rag_project
npm run local-gov:autonomous:polling:arnona
```

```bash
# Bash (Linux/Mac)
export APPT_LOGIN_USER="john.doe"
export APPT_LOGIN_PASS="password"
export APPT_OTP="123456"
export APPT_FULL_NAME="John Doe"
export APPT_ID="123456789"
export APPT_PHONE="0501234567"
export APPT_EMAIL="john@example.com"

cd /path/to/lab_4_RAG/multi_agent_kb_rag_project
npm run local-gov:autonomous:polling:arnona
```

---

### **STEP 2: Run Autonomous Monitoring**

#### **First Run (After Setup)**

```bash
npm run local-gov:autonomous:polling:arnona
```

**Expected Output:**
```
╔════════════════════════════════════════════════════════════════════╗
║     🤖 AUTONOMOUS BOOKING WITH CONTINUOUS SLOT MONITORING        ║
╚════════════════════════════════════════════════════════════════════╝

✓ Using saved credentials (j*** last saved 2026-03-19T21:20:51.244Z)

📋 Configuration:
   Category: arnona
   Website: https://www.tel-aviv.gov.il/Contact/Pages/Apointments.aspx
   Polling every 30s
   Max runtime: 120 minutes
   Auto-book on slots: YES

⏳ Starting polling loop (Ctrl+C to stop)...
```

#### **Ongoing Polling**

The system now continuously checks:

```
[21:25:30] 🔵 Check #1 - No slots (negative-signals-found)
[21:26:00] 🔵 Check #2 - No slots (negative-signals-found)
[21:26:30] 🔵 Check #3 - No slots (negative-signals-found)
[21:27:00] 🔵 Check #4 - No slots (unclear)
[21:27:30] 🔵 Check #5 - No slots (negative-signals-found)  ← Heartbeat (5th check)
...keeps polling...
```

---

### **STEP 3: Slots Detected! 🟢**

When appointments become available:

```
[21:32:00] 🟢 SLOTS DETECTED (87% confidence)
         ↓ (TRIPLE BEEP SOUND 🔊)
         ↓
[21:32:01] 🚀 Starting autonomous booking attempt...
[21:32:05] 🔍 Launching browser...
[21:32:10] 🔒 Auto-login with credentials...
[21:32:15] 🔑 Handling OTP...
[21:32:20] 📝 Filling appointment form...
[21:32:25] ✅ BOOKING SUBMITTED SUCCESSFULLY!
         ↓
[21:32:26] 🏁 Autonomous booking session ended
```

**Database entry created:**
```json
{
  "id": 35,
  "userId": "cli-autonomous-booking",
  "description": "Autonomous booking successfully submitted",
  "status": "approved",
  "notes": {
    "submittedAt": "2026-03-19T21:32:25.000Z",
    "slotCheckNumber": 14,
    "sessionState": "SUBMITTED"
  }
}
```

---

## Part 3: Real-World Scenarios

### **Scenario 1: Smooth Booking**

```bash
npm run local-gov:autonomous:polling:arnona

# Expected timeline:
# - Checks run every 30s
# - After ~5 minutes: Slots appear
# - System alerts immediately
# - Booking completes in ~25 seconds
# - Total time to booking: ~5m 25s
```

### **Scenario 2: Slots Not Available**

```bash
npm run local-gov:autonomous:polling:arnona -- --max-runtime 60

# Expected timeline:
# - Checks run for 60 minutes
# - Heartbeat alert every 5 checks (2.5 minutes)
# - If no slots found after 60 min → Session ends
```

### **Scenario 3: Human Intervention Needed**

If CAPTCHA is detected:

```
[21:32:00] 🟢 SLOTS DETECTED (87% confidence)
[21:32:01] 🚀 Starting autonomous booking attempt...
[21:32:15] 🔒 Auto-login with credentials...
[21:32:20] 🚨 CAPTCHA DETECTED - Human intervention required
[21:32:21] 🌐 Browser window opened for CAPTCHA solving...

# You solve CAPTCHA manually in the browser
# System waits and continues automatically

[21:32:45] ✅ CAPTCHA solved, continuing...
[21:32:55] ✅ BOOKING SUBMITTED SUCCESSFULLY!
```

### **Scenario 4: Network Issues**

```
[21:30:00] 🔵 Check #60 - No slots (negative-signals-found)
[21:30:31] ⚠ Check failed (1/8): Network timeout
[21:31:00] ⚠ Check failed (2/8): ECONNREFUSED
[21:31:30] 🔵 Check #61 - No slots (negative-signals-found)
           ↓ [Auto-recovery successful, continues polling]
```

---

## Part 4: Configuration Variations

### **Fast Checking During Business Hours**

```bash
# Check every 15 seconds
npm run local-gov:autonomous:polling:fast

# Only run for 8 hours
npm run local-gov:autonomous:polling:fast -- --max-runtime 480
```

### **Silent Background Monitoring**

```bash
# No sounds, no visual alerts
npm run local-gov:autonomous:polling:silent

# Check less frequently to reduce load
npm run local-gov:autonomous:polling:silent -- --interval 120 --max-runtime 1440
```

### **Multiple Categories in Parallel**

```bash
# Terminal 1 - Arnona/Tax
npm run local-gov:autonomous:polling:arnona

# Terminal 2 - Other service
npm run local-gov:autonomous:polling -- --category other --interval 60
```

### **Dry Run (No Actual Booking)**

```bash
# Test the whole flow without actually submitting
npm run local-gov:autonomous:polling:arnona -- --dry-run
```

---

## Part 5: Monitoring & Verification

### **Check Session History**

```sql
-- Connect to your database
SELECT * FROM government_requests 
WHERE user_id = 'cli-autonomous-booking'
ORDER BY created_at DESC
LIMIT 10;
```

### **Example Results:**

| ID | Description | Status | Created At |
|---|---|---|---|
| 37 | Autonomous booking successfully submitted | approved | 2026-03-19 21:32:25 |
| 36 | Slot availability detected | approved | 2026-03-19 21:32:00 |
| 35 | Session ended normally | approved | 2026-03-19 21:35:00 |
| 34 | local-gov:api:book command-bus run | approved | 2026-03-19 21:20:51 |

### **Verify Credentials File**

```bash
# View saved credentials (local only!)
cat tmp/booking-creds.json

# Output:
# {
#   "loginUsername": "john.doe",
#   "loginPassword": "password",
#   "otpCode": "123456",
#   "savedAt": "2026-03-19T21:20:51.244Z"
# }
```

---

## Part 6: Troubleshooting Guide

### **Issue 1: "Credentials not found"**

```bash
# Solution: Run setup again
npm run local-gov:autonomous:setup

# Or set env vars and run
$Env:APPT_LOGIN_USER = "username"
$Env:APPT_LOGIN_PASS = "password"
npm run local-gov:autonomous:polling:arnona
```

### **Issue 2: "Website unreachable"**

```bash
# Check internet connection
ping www.tel-aviv.gov.il

# Try manual URL access
Start-Process "https://www.tel-aviv.gov.il/Contact/Pages/Apointments.aspx"

# Increase polling interval (longer timeouts)
npm run local-gov:autonomous:polling:arnona -- --interval 60
```

### **Issue 3: "No slots found" (after long run)**

```sql
-- Check what was actually detected
SELECT * FROM government_requests 
WHERE description LIKE '%Slot%'
ORDER BY created_at DESC;

-- If no results, slots may not be available
```

### **Issue 4: "CAPTCHA appears too often"**

```bash
# The system can't auto-solve CAPTCHAs
# Options:
# 1. Solve manually in the browser that opens
# 2. Adjust checking times (avoid peak hours)
# 3. Use a CAPTCHA solver service (3rd party)
```

### **Issue 5: "Auto-book not working"**

```bash
# Check that auto-book is enabled
npm run local-gov:autonomous:polling:arnona

# Verify it's in the config output:
# Auto-book on slots: YES

# If not enabled, run:
npm run local-gov:autonomous:polling:arnona -- --help

# To force enable:
npm run local-gov:autonomous:polling:arnona  # Uses saved config
```

---

## Part 7: Advanced Usage

### **24/7 Continuous Monitoring**

```bash
# Create a batch file (Windows)

REM monitor.bat
@echo off
:loop
echo Starting monitoring session at %date% %time%
npm run local-gov:autonomous:polling:silent -- --max-runtime 480
echo Session ended, waiting 5 minutes before restart...
timeout /t 300
goto loop
```

```bash
# Or create a shell script (Linux/Mac)

#!/bin/bash
# monitor.sh

while true; do
  echo "Starting monitoring session at $(date)"
  npm run local-gov:autonomous:polling:silent -- --max-runtime 480
  echo "Session ended, waiting 5 minutes before restart..."
  sleep 300
done
```

### **Email Alerts on Booking**

Modify `run_autonomous_booking_with_polling.js` to add email notifications:

```javascript
// Add this after successful booking
await sendEmail({
  to: 'your-email@example.com',
  subject: '✅ Appointment Booked!',
  body: 'Your appointment has been successfully booked.'
});
```

### **Webhook Integration**

```bash
# Send alerts to external service
npm run local-gov:autonomous:polling:arnona

# Update the alertSlotAvailable function to POST to your API:
POST https://your-service.com/webhook/slots-found
{
  "userId": "user",
  "confidence": 0.87,
  "timestamp": "2026-03-19T21:32:00Z"
}
```

---

## Part 8: Security Considerations

### ⚠️ **Credentials Storage**

- Saved to: `tmp/booking-creds.json`
- Format: **Plaintext** (stored locally only)
- Never commit this file to Git
- Never share with others
- Delete when no longer needed

### **Best Practices**

1. ✅ Run on personal/trusted machine only
2. ✅ Use strong passwords
3. ✅ Keep credentials file secure
4. ✅ Monitor session logs regularly
5. ✅ Clear credentials after use: `rm tmp/booking-creds.json`

### **Environment Variable Security**

```bash
# Don't use clear passwords in scripts!
# Instead, use credentials file from setup

# ❌ Bad:
$Env:APPT_LOGIN_PASS = "mypassword"

# ✅ Good:
npm run local-gov:autonomous:setup  # Then just run:
npm run local-gov:autonomous:polling:arnona
```

---

## Part 9: Success Metrics

### **Perfect Run**

✅ Slots detected within monitoring window
✅ Auto-booking triggered immediately
✅ CAPTCHA not encountered (or solved manually)
✅ Booking submitted successfully
✅ Database updated with success status

### **Acceptable Run**

✅ No slots found but system ran stably
✅ All polling checks completed
✅ No errors in monitoring loop
✅ Session ended gracefully

### **Review Run**

⚠️ Few network errors but auto-recovered
⚠️ CAPTCHA encountered and manually solved
⚠️ Partial booking (status stuck at "awaiting confirmation")

---

## Part 10: Next Steps

1. **Run the setup wizard:**
   ```bash
   npm run local-gov:autonomous:setup
   ```

2. **Start autonomous monitoring:**
   ```bash
   npm run local-gov:autonomous:polling:arnona
   ```

3. **Let it run** - check back periodically for alerts

4. **When slots found** - browser will open automatically for booking

5. **Verification** - check database logs for success

---

## Support & Documentation

- 📖 **Full Guide:** [AUTONOMOUS_BOOKING_GUIDE.md](./AUTONOMOUS_BOOKING_GUIDE.md)
- 🔧 **Configuration:** Check `tmp/booking-config.json`
- 📊 **Logs:** Query `government_requests` table
- 🐛 **Issues:** Check `tmp/booking-creds.json` exists and is valid

---

**Your autonomous appointment booking system is ready! 🚀**

Start with: `npm run local-gov:autonomous:setup`
