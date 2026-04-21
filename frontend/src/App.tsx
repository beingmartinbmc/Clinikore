import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Patients from "./pages/Patients";
import PatientDetail from "./pages/PatientDetail";
import Calendar from "./pages/Calendar";
import Procedures from "./pages/Procedures";
import Invoices from "./pages/Invoices";
import InvoiceDetail from "./pages/InvoiceDetail";
import Backups from "./pages/Backups";
import { TourProvider } from "./tour/TourContext";
import WelcomeModal from "./tour/WelcomeModal";

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
          <Route path="invoices" element={<Invoices />} />
          <Route path="invoices/:id" element={<InvoiceDetail />} />
          <Route path="backups" element={<Backups />} />
        </Route>
      </Routes>
      <WelcomeModal />
    </TourProvider>
  );
}
