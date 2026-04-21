import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Patients from "./pages/Patients";
import PatientDetail from "./pages/PatientDetail";
import Calendar from "./pages/Calendar";
import Procedures from "./pages/Procedures";
import Consultations from "./pages/Consultations";
import Invoices from "./pages/Invoices";
import InvoiceDetail from "./pages/InvoiceDetail";
import Backups from "./pages/Backups";
import Reports from "./pages/Reports";
import SettingsPage from "./pages/Settings";
import { TourProvider } from "./tour/TourContext";
import WelcomeModal from "./tour/WelcomeModal";
import OnboardingModal from "./components/OnboardingModal";

export default function App() {
  return (
    <TourProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="patients" element={<Patients />} />
          <Route path="patients/:id" element={<PatientDetail />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="procedures" element={<Procedures />} />
          <Route path="consultations" element={<Consultations />} />
          <Route path="invoices" element={<Invoices />} />
          <Route path="invoices/:id" element={<InvoiceDetail />} />
          <Route path="reports" element={<Reports />} />
          <Route path="backups" element={<Backups />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      {/* OnboardingModal sits on top of the whole app and blocks every
          screen until the doctor has supplied the mandatory identity
          fields (name + clinic + medical-council registration no.).
          It appears on first launch AND whenever those fields are cleared. */}
      <OnboardingModal />
      <WelcomeModal />
    </TourProvider>
  );
}
