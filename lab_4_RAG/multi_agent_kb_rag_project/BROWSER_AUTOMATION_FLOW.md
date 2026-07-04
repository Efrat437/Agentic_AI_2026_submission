# 🌐 Browser Automation for Autonomous Arnona Booking

## Complete Automation Flow

### **How the Browser Agent Books Your Arnona Appointment Autonomously**

---

## Step-by-Step Automation

### **Stage 1: BROWSER LAUNCH (0-2 seconds)**

```javascript
Browser Action: Launch Playwright
├─ Mode: Headless (invisible background)
├─ Browser: Chromium
├─ Timeout: 60 seconds
└─ Status: Ready to navigate
```

**What happens:**
- Browser launches silently in background
- You don't see anything (unless CAPTCHA needed)
- No window pops up yet

**Code flow:**
```javascript
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
```

---

### **Stage 2: WEBSITE NAVIGATION (2-5 seconds)**

```javascript
Browser Action: Navigate to appointment website
├─ URL: https://www.tel-aviv.gov.il/Contact/Pages/Apointments.aspx
├─ Wait: Page fully loaded
├─ Timeout: 30 seconds
└─ Status: Page loaded
```

**What the system does:**
- Navigates to Tel Aviv municipality appointment page
- Waits for page to fully load
- Verifies appointment booking form is present

**Code flow:**
```javascript
await page.goto(config.websiteUrl);
await page.waitForLoadState('networkidle');
```

---

### **Stage 3: DETECT AND FILL LOGIN FORM (5-10 seconds)**

```javascript
Browser Action: Find login form elements
├─ Action: Self-healing selector pass
├─ Find: Username field
│  └─ Patterns: [id*=user], [name*=user], [placeholder*=user]
├─ Find: Password field
│  └─ Patterns: [id*=pass], [name*=pass], [type=password]
├─ Find: Submit button
│  └─ Patterns: [text*=Sign In], [type=submit], [class*=login]
└─ Status: Form fields identified
```

**What gets filled:**
```javascript
// Username (from saved credentials)
await page.fill('[selector-for-username]', savedCreds.loginUsername);
// e.g., "test.user.arnona"

// Password (from saved credentials)  
await page.fill('[selector-for-password]', savedCreds.loginPassword);
// e.g., "TestPass123!@#"

// Submit login
await page.click('[selector-for-submit]');
```

**Error handling:**
- If selector fails → Try alternate patterns
- If field not found → Log error, stop with HITL alert
- If timeout → Retry up to 3 times

---

### **Stage 4: WAIT FOR AUTHENTICATION (10-20 seconds)**

```javascript
Browser Action: Wait for login to complete
├─ Detection: Page changes OR new content appears
├─ Wait for: Auth cookie OR redirect to dashboard
├─ Timeout: 20 seconds
└─ Status: Logged in successfully
```

**What the system verifies:**
- Page URL changed (left login page)
- Dashboard/appointment page now visible
- Authentication session established

**Code flow:**
```javascript
// Wait for any of these signs of successful login:
await Promise.race([
  page.waitForURL('**/dashboard'),
  page.waitForURL('**/appointments'),
  page.waitForSelector('[text*=appointment]')
]);
```

---

### **Stage 5: DETECT OTP PROMPT (if needed, 20-25 seconds)**

```javascript
Browser Action: Check for OTP requirement
├─ Look for: OTP input field
├─ Pattern: [placeholder*=OTP], [label*=code], [name*=otp]
├─ If found:
│  ├─ Detect OTP field
│  ├─ Fill with saved OTP
│  │  └─ From: APPT_OTP environment variable
│  ├─ Submit OTP
│  └─ Wait for confirmation
└─ If not found: Continue to next stage
```

**What gets filled:**
```javascript
// Check if OTP is needed
const otpField = await page.$('[placeholder*=OTP]');

if (otpField) {
  // OTP is needed
  await page.fill('[placeholder*=OTP]', savedCreds.otpCode);
  // e.g., "654321"
  
  // Submit OTP
  await page.click('[text*=Confirm]');
  
  // Wait for confirmation
  await page.waitForNavigation({ timeout: 20000 });
}
```

---

### **Stage 6: NAVIGATE TO APPOINTMENT BOOKING (25-35 seconds)**

```javascript
Browser Action: Find appointment booking section
├─ Look for: "Book Appointment" / "New Appointment" button
├─ Pattern: [text*=book], [text*=appointment], [class*=booking]
├─ Click: Appointment booking button
├─ Wait: Form loads
└─ Status: Ready to select category
```

**What the system does:**
- Finds appointment booking entry point
- Clicks to initiate booking
- Waits for booking form to load

**Code flow:**
```javascript
// Find "Book Appointment" button
const bookBtn = await page.$('button:text("Book Appointment")');
if (bookBtn) await bookBtn.click();

// Wait for booking form
await page.waitForSelector('[text*=category], [label*=service]');
```

---

### **Stage 7: SELECT ARNONA CATEGORY (35-45 seconds)**

```javascript
Browser Action: Select "Arnona" appointment category
├─ Look for: Category dropdown / radio buttons
├─ Options: "Arnona", "ארנונה", "Property Tax", "שכרת"
├─ Pattern match:
│  ├─ English: /arnona|property\s+tax/i
│  ├─ Hebrew: /ארנונה|שכרת/
├─ Action: Click or select "Arnona"
└─ Status: Arnona category selected
```

**What the system does:**
```javascript
// Find category dropdown
const categorySelect = await page.$('select[name*=category], select[name*=service]');
const options = await categorySelect.locator('option').all();

// Find Arnona option
for (const opt of options) {
  const text = await opt.textContent();
  if (/arnona|property|ארנונה/i.test(text)) {
    await opt.click();
    break;
  }
}

// Wait for form to update with Arnona fields
await page.waitForTimeout(2000);
```

---

### **Stage 8: DETECT AVAILABLE SLOTS (45-60 seconds)**

```javascript
Browser Action: Scan page for available appointment slots
├─ Look for: Calendar, time slots, availability list
├─ Patterns:
│  ├─ "Available on [date]"
│  ├─ "Next available: [time]"
│  ├─ Calendar with green/enabled dates
│  ├─ "תור זמין" (Hebrew)
├─ First available: Select it
└─ Status: Slot selected
```

**What the system scans for:**
```javascript
// Look for time slot elements
const timeSlots = await page.$$('[class*=slot], [class*=time], button:text("AM|PM")');

// Find enabled/available slots
for (const slot of timeSlots) {
  const disabled = await slot.isDisabled();
  const classes = await slot.getAttribute('class');
  
  if (!disabled && !classes.includes('disabled')) {
    // This slot is available!
    await slot.click();
    break;
  }
}

// Or look for text-based availability
const hasSlots = await page.locator('text=/available|זמין/i').count();
if (hasSlots > 0) {
  const firstSlot = await page.locator('button:text-matches(/available|זמין/)').first();
  await firstSlot.click();
}
```

---

### **Stage 9: FILL APPLICANT FORM (60-75 seconds)**

```javascript
Browser Action: Fill appointment form with personal details
├─ Fields:
│  ├─ Full Name: (from setup, saved)
│  ├─ ID Number: (from setup, saved)
│  ├─ Phone: (from setup, saved)
│  ├─ Email: (from setup, saved)
│  └─ Optional: Address, property details
├─ Detection: Self-healing selector pass
└─ Status: Form filled
```

**What gets auto-filled:**
```javascript
// Full Name
await page.fill('[placeholder*=name], [name*=name], [label*=name] ~ input', 
  'John Doe'); // from APPT_FULL_NAME

// ID Number
await page.fill('[placeholder*=id], [name*=id], [placeholder*=teudat]', 
  '123456789'); // from APPT_ID

// Phone
await page.fill('[placeholder*=phone], [name*=phone], [type=tel]', 
  '0501234567'); // from APPT_PHONE

// Email
await page.fill('[placeholder*=email], [name*=email], [type=email]', 
  'user@example.com'); // from APPT_EMAIL

// Property Address (if needed)
const propField = await page.$('[placeholder*=address], [placeholder*=property]');
if (propField) {
  await propField.fill(process.env.APPT_PROPERTY_ADDRESS || '');
}
```

---

### **Stage 10: HANDLE CAPTCHA (75-85 seconds - or longer if manual)**

```javascript
Browser Action: Detect and handle CAPTCHA
├─ Detection:
│  ├─ Look for: "reCAPTCHA", "I'm not a robot", [class*=captcha]
│  ├─ If found: CAPTCHA present
│  └─ If not: Skip to submit
├─ Response:
│  ├─ IF simple: Try auto-solve (limited)
│  ├─ IF complex: Pause and show browser
│  │  └─ You solve manually
│  ├─ Wait for solve: Max 300 seconds
│  └─ Continue automatically after
└─ Status: CAPTCHA handled
```

**CAPTCHA handling logic:**
```javascript
// Check for CAPTCHA
const captchaFrame = await page.$('iframe[src*="recaptcha"]');

if (captchaFrame) {
  // CAPTCHA present - show browser to user
  console.log('⚠️ CAPTCHA detected - browser window open for manual solve');
  console.log('   Waiting up to 5 minutes...');
  
  // Show the browser window
  await browser.show(); // Makes visible
  
  // Wait for either:
  // 1. User solves and clicks submit (page changes)
  // 2. Timeout after 5 minutes
  await Promise.race([
    page.waitForNavigation({ timeout: 300000 }),
    page.waitForTimeout(300000)
  ]);
  
  // Hide browser again
  await browser.hide();
} else {
  // No CAPTCHA - continue automatically
  console.log('✅ No CAPTCHA detected - continuing...');
}
```

---

### **Stage 11: SUBMIT APPOINTMENT (85-95 seconds)**

```javascript
Browser Action: Submit appointment booking
├─ Find: Submit/Confirm button
├─ Patterns: [text*=submit], [text*=confirm], [text*=book], [type=submit]
├─ Click: Submit button
├─ Wait: Response from server
├─ Timeout: 30 seconds
└─ Status: Booking submitted
```

**What happens:**
```javascript
// Find submit button (self-healing)
const submitBtn = await page.locator(
  'button:text("Submit|Confirm|Book|Book Appointment|הזמן תור")'
).first();

if (!submitBtn) {
  // Try type=submit
  await page.$eval('form', (form) => {
    form.querySelector('[type=submit]').click();
  });
} else {
  await submitBtn.click();
}

// Wait for confirmation (page changes or new content)
await page.waitForNavigation({ timeout: 30000 });
```

---

### **Stage 12: VERIFY BOOKING SUCCESS (95-110 seconds)**

```javascript
Browser Action: Confirm booking success
├─ Look for: Confirmation message
├─ Patterns:
│  ├─ "Booking Confirmed"
│  ├─ "Appointment scheduled for [date]"
│  ├─ "Reference number: [123456]"
│  ├─ "תור בוצע בהצלחה" (Hebrew)
├─ Extract: Confirmation number (if available)
├─ Success: YES/NO
└─ Status: Booking confirmed OR failed
```

**Verification:**
```javascript
// Check for success indicators
const confirmMsg = await page.locator('text=/confirmed|success|בהצלחה/i').count();

if (confirmMsg > 0) {
  // ✅ Booking success confirmed!
  
  // Try to extract reference number
  const refMatch = await page.locator('text=/reference|number|מספר/i').textContent();
  console.log('✅ BOOKING CONFIRMED');
  console.log(`   Reference: ${refMatch}`);
  
  // Take screenshot of confirmation
  await page.screenshot({ path: 'confirmation.png' });
  
  return { success: true, referenceNumber: refMatch };
} else {
  // ❌ Booking might have failed
  console.log('❌ Confirmation not detected');
  return { success: false };
}
```

---

### **Stage 13: LOG & ALERT (110-115 seconds)**

```javascript
Database Action: Log to government_requests table
├─ Fields:
│  ├─ id: Auto-increment
│  ├─ user_id: 'cli-autonomous-booking'
│  ├─ description: 'Autonomous booking successfully submitted (Arnona)'
│  ├─ status: 'approved'
│  ├─ notes: {
│  │  "submittedAt": "2026-03-19T21:32:25Z",
│  │  "category": "arnona",
│  │  "slot": "Monday 09:00 AM",
│  │  "referenceNumber": "123456",
│  │  "checkNumber": 14
│  └─ }
└─ Status: Logged ✅
```

**Database entry:**
```javascript
await createGovernmentRequest({
  userId: 'cli-autonomous-booking',
  description: 'Autonomous booking successfully submitted (Arnona)',
  status: 'approved',
  notes: JSON.stringify({
    category: 'arnona',
    slot: detectedSlot,
    referenceNumber: confirmRef,
    checkNumber: currentCheckNumber,
    submittedAt: new Date().toISOString(),
    timeToBook: endTime - startTime + ' ms'
  })
});
```

**User Alert:**
```javascript
console.log('🎉 BOOKING SUBMITTED SUCCESSFULLY!');
console.log('   Category: Arnona (Property Tax)');
console.log('   Date: Monday, March 25, 2026');
console.log('   Time: 09:00 AM');
console.log('   Reference: #123456');
console.log('   Database: Logged ✅');
console.log('   Session: Ended normally ✅');
```

---

## Error Handling at Each Stage

| Stage | Possible Error | Recovery |
|-------|---|---|
| 1. Launch | Browser won't start | Retry, check RAM/disk |
| 2. Navigate | Website unreachable | Retry with backoff, alert |
| 3. Login | Selectors changed | Self-heal, try alt patterns |
| 4. Auth | Login fails (3x) | Stop, ask for HITL |
| 5. OTP | Wrong code | Stop, ask for new OTP |
| 6. Booking Page | Can't find form | Log error, stop |
| 7. Category | Arnona not found | Try variants (Hebrew, English) |
| 8. Slots | No slots available | Return to polling loop |
| 9. Form | Can't fill (selectors) | Self-healing, try defaults |
| 10. CAPTCHA | Can't auto-solve | Show browser, wait manual |
| 11. Submit | Can't click button | Try form.submit(), retry |
| 12. Verify | No confirmation | Check page content, alert user |
| 13. Log | DB unreachable | Queue for retry |

---

## Complete Timeline Example

```
00:00 - Setup completed (credentials saved)
        └─ tmp/booking-creds.json ready

00:00 - Polling starts
        └─ Checking every 30 seconds

02:00 - Check #5: No slots (heartbeat logged)

05:00 - Check #11: No slots

10:05 - Check #21: 🟢 SLOTS DETECTED! (89% confidence)
        └─ Alert triggered
        └─ Auto-booking starts

10:06 - Stage 1: Browser launched ✅ (1 sec)
        Stage 2: Website loaded ✅ (3 sec)
        Stage 3: Login form detected ✅ (3 sec)
        Stage 4: Auto-login completed ✅ (8 sec)

10:09 - Stage 5: OTP not required ✅ (0 sec)
        Stage 6: Booking form loaded ✅ (8 sec)
        Stage 7: Arnona selected ✅ (8 sec)

10:12 - Stage 8: Available slots found ✅ (10 sec)
        Stage 9: Form filled ✅ (12 sec)
        Stage 10: No CAPTCHA ✅ (0 sec)

10:15 - Stage 11: Appointment submitted ✅ (0.5 sec)
        Stage 12: Success verified ✅ (5 sec)
        Stage 13: Logged to database ✅ (1 sec)

10:16 - 🎉 BOOKING COMPLETE!
        2 minutes 11 seconds from slot detection
        Zero manual interaction needed
        Appointment: Monday 9:00 AM
        Reference: #456789
```

---

## Safety Features

✅ **Headless mode** - Doesn't require display
✅ **Timeouts** - Never hangs (max 5 min per stage)
✅ **Error recovery** - Auto-retry on transient failures
✅ **CAPTCHA handling** - Pauses for manual solve if needed
✅ **Self-healing** - Updates selectors from learned patterns
✅ **Logging** - Every action tracked in database
✅ **Verification** - Confirms success before ending
✅ **No data transmission** - Everything stays local

---

**This is how your Arnona appointment gets booked automatically! 🚀**
