import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { findNavItem } from '../app/navigation'
import { Header } from './Header'
import { Sidebar } from './Sidebar'

/**
 * The frame around every page: sidebar + header + main content.
 * The only state here is whether the mobile drawer is open, because
 * that is the only interactive thing this component controls.
 */
export function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const { pathname } = useLocation()

  const title = findNavItem(pathname)?.label ?? 'Page not found'

  // Keep the browser tab title in sync with the current page.
  useEffect(() => {
    document.title = `${title} | YMT School Management`
  }, [title])

  // Escape closes the mobile drawer. The listener exists only while it is open.
  useEffect(() => {
    if (!sidebarOpen) return

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setSidebarOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [sidebarOpen])

  const closeSidebar = () => setSidebarOpen(false)

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      {sidebarOpen ? (
        <div
          className="sidebar-overlay"
          aria-hidden="true"
          onClick={closeSidebar}
        />
      ) : null}

      <div className="app-main-area">
        <Header
          title={title}
          sidebarOpen={sidebarOpen}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <div className="demo-banner" role="note">
          <strong>Development demo.</strong> All figures are fictional sample
          data and are not connected to any real school records.
        </div>
        <main id="main-content" className="app-main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
