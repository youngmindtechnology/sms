import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthContext'
import { ProtectedRoute } from '../auth/ProtectedRoute'
import { AppLayout } from '../layouts/AppLayout'
import { LoginPage } from '../pages/LoginPage'
import { CalendarPage } from '../pages/CalendarPage'
import { ClassesPage } from '../pages/ClassesPage'
import { DashboardPage } from '../pages/DashboardPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { PlaceholderPage } from '../pages/PlaceholderPage'
import { StaffPage } from '../pages/StaffPage'
import { SubjectsPage } from '../pages/SubjectsPage'
import { StudentProfilePage } from '../pages/StudentProfilePage'
import { StudentsPage } from '../pages/StudentsPage'
import { navItems } from './navigation'

/**
 * Route table. Every page renders inside <AppLayout />, which provides the
 * sidebar and header and shows the active page through <Outlet />.
 * Modules marked 'planned' share one PlaceholderPage component.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="calendar" element={<CalendarPage />} />
          <Route path="classes" element={<ClassesPage />} />
          <Route path="staff" element={<StaffPage />} />
          <Route path="academics" element={<SubjectsPage />} />
          <Route path="students" element={<StudentsPage />} />
          <Route path="students/:studentId" element={<StudentProfilePage />} />
          {navItems
            .filter((item) => item.status === 'planned')
            .map((item) => (
              <Route
                key={item.path}
                path={item.path}
                element={<PlaceholderPage item={item} />}
              />
            ))}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        </Route>
      </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
