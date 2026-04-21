/**
 * Translations dictionary. Two locales for now: English and Hindi.
 *
 * Add new keys as dotted strings grouped by feature area. Prefer short,
 * reusable keys (e.g. `common.save`) over long page-specific strings.
 * Missing keys in a locale fall back to English at runtime.
 */
export type Locale = "en" | "hi";

type Dict = Record<string, string>;

export const locales: { code: Locale; label: string; nativeLabel: string }[] = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
];

export const translations: Record<Locale, Dict> = {
  en: {
    "app.name": "Clinikore",
    "app.tagline": "Clinic Manager",
    "app.offline_sqlite": "Offline · SQLite",

    // Navigation
    "nav.dashboard": "Dashboard",
    "nav.patients": "Patients",
    "nav.calendar": "Calendar",
    "nav.procedures": "Procedures",
    "nav.invoices": "Invoices",
    "nav.backups": "Backups",
    "nav.help": "Help & tour",

    // Common buttons
    "common.save": "Save",
    "common.cancel": "Cancel",
    "common.delete": "Delete",
    "common.edit": "Edit",
    "common.add": "Add",
    "common.new": "New",
    "common.back": "Back",
    "common.next": "Next",
    "common.finish": "Finish",
    "common.refresh": "Refresh",
    "common.close": "Close",
    "common.loading": "Loading...",
    "common.search": "Search...",
    "common.yes": "Yes",
    "common.no": "No",
    "common.notes": "Notes",

    // Dashboard
    "dashboard.title": "Dashboard",
    "dashboard.subtitle": "Snapshot of today's activity",
    "dashboard.patients": "Patients",
    "dashboard.today_appts": "Today's appointments",
    "dashboard.pending_invoices": "Pending invoices",
    "dashboard.pending_dues": "Pending dues",
    "dashboard.this_month": "This month",
    "dashboard.payments_received": "Payments received",
    "dashboard.today_list": "Today's appointments",
    "dashboard.no_appts_today": "No appointments scheduled for today.",

    // Patients
    "patients.title": "Patients",
    "patients.subtitle_count": "{count} registered",
    "patients.new": "New patient",
    "patients.search_placeholder": "Search by name or phone...",
    "patients.col.name": "Name",
    "patients.col.age": "Age",
    "patients.col.contact": "Contact",
    "patients.col.allergies": "Allergies",
    "patients.col.registered": "Registered",
    "patients.empty": "No patients yet. Add your first one.",
    "patients.form.name": "Full name",
    "patients.form.phone": "Phone",
    "patients.form.email": "Email",
    "patients.form.medical_history": "Medical history",
    "patients.form.dental_history": "Dental history",
    "patients.form.allergies": "Allergies",
    "patients.confirm_delete": "Delete this patient and all related records?",
    "patients.added": "Patient added",
    "patients.deleted": "Patient deleted",

    // Calendar
    "calendar.title": "Calendar",
    "calendar.subtitle": "Day & week view · click a slot to book",
    "calendar.new_appt": "New appointment",
    "calendar.appointment": "Appointment",
    "calendar.form.patient": "Patient",
    "calendar.form.start": "Start",
    "calendar.form.end": "End",
    "calendar.form.complaint": "Chief complaint",
    "calendar.mark_completed": "Mark completed",
    "calendar.send_sms": "Send SMS",
    "calendar.send_whatsapp": "WhatsApp",
    "calendar.book": "Book",
    "calendar.save_changes": "Save changes",
    "calendar.confirm_delete": "Delete this appointment?",

    // Procedures
    "procedures.title": "Procedures",
    "procedures.subtitle": "Catalog & default pricing",
    "procedures.new": "New procedure",
    "procedures.col.name": "Name",
    "procedures.col.description": "Description",
    "procedures.col.default_price": "Default price (₹)",
    "procedures.empty": "No procedures defined yet.",

    // Invoices
    "invoices.title": "Invoices",
    "invoices.new": "New invoice",
    "invoices.pending_dues": "Pending dues",
    "invoices.show_pending_only": "Show pending only",
    "invoices.col.patient": "Patient",
    "invoices.col.date": "Date",
    "invoices.col.total": "Total",
    "invoices.col.paid": "Paid",
    "invoices.col.balance": "Balance",
    "invoices.col.status": "Status",
    "invoices.empty": "No invoices yet.",
    "invoices.status.paid": "Paid",
    "invoices.status.partial": "Partial",
    "invoices.status.unpaid": "Unpaid",

    // Appointment status
    "appt.scheduled": "Scheduled",
    "appt.completed": "Completed",
    "appt.cancelled": "Cancelled",

    // Backups
    "backups.title": "Backups",
    "backups.subtitle": "Your data is safe — snapshots are taken automatically.",
    "backups.backup_now": "Backup now",
    "backups.schedule": "Schedule",
    "backups.schedule_value": "Every {hours}h",
    "backups.schedule_note": "Plus one snapshot at every app launch",
    "backups.retention": "Retention",
    "backups.retention_value": "Last {keep} snapshots",
    "backups.retention_note": "Older snapshots are auto-pruned",
    "backups.location": "Location",
    "backups.location_note": "Copy this folder to a USB drive for offsite backup",
    "backups.col.snapshot": "Snapshot",
    "backups.col.created": "Created",
    "backups.col.size": "Size",
    "backups.col.records": "Records",
    "backups.empty": "No backups yet. One is taken at startup — try clicking Backup now.",
    "backups.offsite_title": "Offsite backup tip",
    "backups.offsite_body":
      "Automatic backups protect against data corruption and accidental deletes, but they live on the same laptop as the main database. Once a week, download the latest snapshot zip and copy it to a USB stick or cloud drive so you're safe even if the laptop is lost, stolen, or the disk fails.",

    // Welcome / Tour
    "welcome.kicker": "Welcome to",
    "welcome.intro":
      "Your offline clinic manager — patient charts, appointments, invoices, and automatic backups. Everything stays on this laptop.",
    "welcome.feature.charts.title": "Patient charts",
    "welcome.feature.charts.body": "Full history, allergies, treatments",
    "welcome.feature.calendar.title": "Smart calendar",
    "welcome.feature.calendar.body": "Slot-based booking with reminders",
    "welcome.feature.invoices.title": "Invoices & dues",
    "welcome.feature.invoices.body": "Auto totals, cash/UPI/card tracking",
    "welcome.feature.backups.title": "Auto backups",
    "welcome.feature.backups.body": "Your data is never lost",
    "welcome.cta.load_and_tour": "Load sample data & take a tour",
    "welcome.cta.tour_only": "Tour without sample data",
    "welcome.cta.take_tour": "Take a tour of the app",
    "welcome.cta.explore": "I'll explore on my own",
    "welcome.cta.working": "Working...",
    "welcome.demo_active":
      "Sample demo data is currently loaded in your database.",
    "welcome.demo_clear": "Clear",
    "welcome.footer":
      "You can restart this any time from the sidebar → Help & tour.",

    // Tour banner
    "tour.label": "Guided tour",
    "tour.step": "Step {current} of {total}",
    "tour.back": "Back",
    "tour.next": "Next",
    "tour.finish": "Finish",
    "tour.skip": "Skip tour",

    // Tour steps
    "tour.dashboard.title": "Your Dashboard",
    "tour.dashboard.body":
      "A quick pulse on your day: total patients, today's appointments, pending dues, and revenue this month. Everything important, in one glance.",
    "tour.patients.title": "Patients",
    "tour.patients.body":
      "Every patient's profile, medical & dental history, allergies and notes live here. Click a name to see their full chart and treatment history.",
    "tour.calendar.title": "Calendar & Appointments",
    "tour.calendar.body":
      "Switch between day and week views. Click-and-drag on any empty slot to book. Click an existing appointment to mark it completed, cancel, or send an SMS/WhatsApp reminder to the patient.",
    "tour.procedures.title": "Procedures & Pricing",
    "tour.procedures.body":
      "Your catalog of procedures with default prices — used when you create invoices so you don't re-type the amount every time.",
    "tour.invoices.title": "Invoices & Payments",
    "tour.invoices.body":
      "Invoices are generated per visit. Track cash / UPI / card payments, see pending dues at a glance, and download a PDF to share with patients.",
    "tour.backups.title": "Your Data is Safe",
    "tour.backups.body":
      "Automatic snapshots every few hours, including a full CSV export of every table. Download a zip and drop it on a USB stick for offsite safety. You can never lose your data.",

    // Language switcher
    "lang.label": "Language",
  },

  hi: {
    "app.name": "क्लिनिकोर",
    "app.tagline": "क्लिनिक प्रबंधक",
    "app.offline_sqlite": "ऑफलाइन · SQLite",

    "nav.dashboard": "डैशबोर्ड",
    "nav.patients": "मरीज़",
    "nav.calendar": "कैलेंडर",
    "nav.procedures": "प्रक्रियाएँ",
    "nav.invoices": "बिल",
    "nav.backups": "बैकअप",
    "nav.help": "सहायता और टूर",

    "common.save": "सहेजें",
    "common.cancel": "रद्द करें",
    "common.delete": "हटाएँ",
    "common.edit": "संपादित करें",
    "common.add": "जोड़ें",
    "common.new": "नया",
    "common.back": "पीछे",
    "common.next": "आगे",
    "common.finish": "समाप्त",
    "common.refresh": "रीफ़्रेश",
    "common.close": "बंद करें",
    "common.loading": "लोड हो रहा है...",
    "common.search": "खोजें...",
    "common.yes": "हाँ",
    "common.no": "नहीं",
    "common.notes": "टिप्पणियाँ",

    "dashboard.title": "डैशबोर्ड",
    "dashboard.subtitle": "आज की गतिविधि का सारांश",
    "dashboard.patients": "मरीज़",
    "dashboard.today_appts": "आज की अपॉइंटमेंट",
    "dashboard.pending_invoices": "लंबित बिल",
    "dashboard.pending_dues": "लंबित बकाया",
    "dashboard.this_month": "इस महीने",
    "dashboard.payments_received": "प्राप्त भुगतान",
    "dashboard.today_list": "आज की अपॉइंटमेंट",
    "dashboard.no_appts_today": "आज कोई अपॉइंटमेंट निर्धारित नहीं है।",

    "patients.title": "मरीज़",
    "patients.subtitle_count": "{count} पंजीकृत",
    "patients.new": "नया मरीज़",
    "patients.search_placeholder": "नाम या फ़ोन से खोजें...",
    "patients.col.name": "नाम",
    "patients.col.age": "उम्र",
    "patients.col.contact": "संपर्क",
    "patients.col.allergies": "एलर्जी",
    "patients.col.registered": "पंजीकृत",
    "patients.empty": "अभी कोई मरीज़ नहीं है। पहला जोड़ें।",
    "patients.form.name": "पूरा नाम",
    "patients.form.phone": "फ़ोन",
    "patients.form.email": "ईमेल",
    "patients.form.medical_history": "चिकित्सा इतिहास",
    "patients.form.dental_history": "दंत चिकित्सा इतिहास",
    "patients.form.allergies": "एलर्जी",
    "patients.confirm_delete": "इस मरीज़ और सभी संबंधित रिकॉर्ड हटाएँ?",
    "patients.added": "मरीज़ जोड़ा गया",
    "patients.deleted": "मरीज़ हटाया गया",

    "calendar.title": "कैलेंडर",
    "calendar.subtitle": "दिन और सप्ताह दृश्य · स्लॉट पर क्लिक करें",
    "calendar.new_appt": "नई अपॉइंटमेंट",
    "calendar.appointment": "अपॉइंटमेंट",
    "calendar.form.patient": "मरीज़",
    "calendar.form.start": "शुरू",
    "calendar.form.end": "समाप्त",
    "calendar.form.complaint": "मुख्य शिकायत",
    "calendar.mark_completed": "पूर्ण चिह्नित करें",
    "calendar.send_sms": "SMS भेजें",
    "calendar.send_whatsapp": "WhatsApp",
    "calendar.book": "बुक करें",
    "calendar.save_changes": "परिवर्तन सहेजें",
    "calendar.confirm_delete": "यह अपॉइंटमेंट हटाएँ?",

    "procedures.title": "प्रक्रियाएँ",
    "procedures.subtitle": "कैटलॉग और डिफ़ॉल्ट मूल्य",
    "procedures.new": "नई प्रक्रिया",
    "procedures.col.name": "नाम",
    "procedures.col.description": "विवरण",
    "procedures.col.default_price": "डिफ़ॉल्ट मूल्य (₹)",
    "procedures.empty": "अभी कोई प्रक्रिया परिभाषित नहीं है।",

    "invoices.title": "बिल",
    "invoices.new": "नया बिल",
    "invoices.pending_dues": "लंबित बकाया",
    "invoices.show_pending_only": "केवल लंबित दिखाएँ",
    "invoices.col.patient": "मरीज़",
    "invoices.col.date": "तारीख़",
    "invoices.col.total": "कुल",
    "invoices.col.paid": "भुगतान",
    "invoices.col.balance": "शेष",
    "invoices.col.status": "स्थिति",
    "invoices.empty": "अभी कोई बिल नहीं है।",
    "invoices.status.paid": "भुगतान किया गया",
    "invoices.status.partial": "आंशिक",
    "invoices.status.unpaid": "अवैतनिक",

    "appt.scheduled": "निर्धारित",
    "appt.completed": "पूर्ण",
    "appt.cancelled": "रद्द",

    "backups.title": "बैकअप",
    "backups.subtitle":
      "आपका डेटा सुरक्षित है — स्नैपशॉट स्वतः लिए जाते हैं।",
    "backups.backup_now": "अभी बैकअप लें",
    "backups.schedule": "शेड्यूल",
    "backups.schedule_value": "हर {hours} घंटे",
    "backups.schedule_note": "ऐप लॉन्च पर एक अतिरिक्त स्नैपशॉट भी",
    "backups.retention": "अवधारण",
    "backups.retention_value": "पिछले {keep} स्नैपशॉट",
    "backups.retention_note": "पुराने स्नैपशॉट स्वतः हटाए जाते हैं",
    "backups.location": "स्थान",
    "backups.location_note":
      "ऑफ़साइट बैकअप के लिए इस फ़ोल्डर को USB ड्राइव पर कॉपी करें",
    "backups.col.snapshot": "स्नैपशॉट",
    "backups.col.created": "बनाया गया",
    "backups.col.size": "आकार",
    "backups.col.records": "रिकॉर्ड",
    "backups.empty":
      "अभी कोई बैकअप नहीं है। स्टार्टअप पर एक लिया जाता है — 'अभी बैकअप लें' पर क्लिक करें।",
    "backups.offsite_title": "ऑफ़साइट बैकअप सुझाव",
    "backups.offsite_body":
      "स्वचालित बैकअप डेटा भ्रष्टाचार और आकस्मिक विलोपन से बचाते हैं, लेकिन वे उसी लैपटॉप पर रहते हैं। सप्ताह में एक बार नवीनतम स्नैपशॉट zip डाउनलोड करके USB या क्लाउड पर कॉपी करें।",

    "welcome.kicker": "स्वागत है",
    "welcome.intro":
      "आपका ऑफ़लाइन क्लिनिक मैनेजर — मरीज़ चार्ट, अपॉइंटमेंट, बिल और स्वचालित बैकअप। सब कुछ इसी लैपटॉप पर रहता है।",
    "welcome.feature.charts.title": "मरीज़ चार्ट",
    "welcome.feature.charts.body": "पूरा इतिहास, एलर्जी, उपचार",
    "welcome.feature.calendar.title": "स्मार्ट कैलेंडर",
    "welcome.feature.calendar.body": "अनुस्मारक के साथ स्लॉट बुकिंग",
    "welcome.feature.invoices.title": "बिल और बकाया",
    "welcome.feature.invoices.body": "स्वत: योग, नकद/UPI/कार्ड ट्रैकिंग",
    "welcome.feature.backups.title": "स्वचालित बैकअप",
    "welcome.feature.backups.body": "आपका डेटा कभी नहीं खोएगा",
    "welcome.cta.load_and_tour": "नमूना डेटा लोड करें और टूर लें",
    "welcome.cta.tour_only": "नमूना डेटा के बिना टूर",
    "welcome.cta.take_tour": "ऐप का टूर लें",
    "welcome.cta.explore": "मैं स्वयं खोजूँगा/खोजूँगी",
    "welcome.cta.working": "कार्य जारी है...",
    "welcome.demo_active": "आपके डेटाबेस में अभी नमूना डेटा लोड है।",
    "welcome.demo_clear": "हटाएँ",
    "welcome.footer":
      "साइडबार → सहायता और टूर से आप इसे कभी भी फिर से शुरू कर सकते हैं।",

    "tour.label": "निर्देशित टूर",
    "tour.step": "चरण {current} / {total}",
    "tour.back": "पीछे",
    "tour.next": "आगे",
    "tour.finish": "समाप्त",
    "tour.skip": "टूर छोड़ें",

    "tour.dashboard.title": "आपका डैशबोर्ड",
    "tour.dashboard.body":
      "आपके दिन की त्वरित झलक: कुल मरीज़, आज की अपॉइंटमेंट, लंबित बकाया और इस महीने की आय।",
    "tour.patients.title": "मरीज़",
    "tour.patients.body":
      "हर मरीज़ का प्रोफ़ाइल, चिकित्सा और दंत इतिहास, एलर्जी और नोट्स यहाँ रहते हैं। पूरा चार्ट देखने के लिए नाम पर क्लिक करें।",
    "tour.calendar.title": "कैलेंडर और अपॉइंटमेंट",
    "tour.calendar.body":
      "दिन और सप्ताह दृश्य के बीच स्विच करें। किसी भी खाली स्लॉट पर क्लिक करके बुक करें।",
    "tour.procedures.title": "प्रक्रियाएँ और मूल्य",
    "tour.procedures.body":
      "डिफ़ॉल्ट मूल्यों के साथ प्रक्रियाओं का कैटलॉग — बिल बनाते समय स्वतः भरा जाता है।",
    "tour.invoices.title": "बिल और भुगतान",
    "tour.invoices.body":
      "बिल प्रति मुलाक़ात बनते हैं। नकद / UPI / कार्ड भुगतान ट्रैक करें और PDF डाउनलोड करें।",
    "tour.backups.title": "आपका डेटा सुरक्षित है",
    "tour.backups.body":
      "हर कुछ घंटों में स्वचालित स्नैपशॉट, सभी टेबल का CSV एक्सपोर्ट सहित। zip डाउनलोड करके USB पर कॉपी करें।",

    "lang.label": "भाषा",
  },
};
