import { Link, Outlet, useLocation } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Wrench } from 'lucide-react';
import { isClientFacingDeployment, isPathVisibleInDeployment } from '@/lib/clientFacing';

/**
 * Route-level half of client-facing mode (the nav half lives in
 * useNavigationVisibility). Sits around the dashboard outlet so a direct URL
 * cannot reach what the navigation no longer links — otherwise a bookmark or a
 * pasted link would land an operator tool in front of a client with the nav
 * filter none the wiser.
 *
 * Presentation only: ModuleGuard and the server's own checks still decide
 * access on every surface this lets through.
 */
export function ClientFacingGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();

  if (!isPathVisibleInDeployment(location.pathname, isClientFacingDeployment())) {
    return (
      <div className="p-6">
        <Alert>
          <Wrench className="h-4 w-4" />
          <AlertTitle>Not available on this dashboard</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              This tool is part of the internal operations console and is not included in this
              client-facing deployment.
            </p>
            <Button asChild size="sm" variant="outline">
              <Link to="/">Back to Overview</Link>
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return <>{children}</>;
}

/** Drop-in for the dashboard layout's `<Outlet />`, keeping the gate one line at each mount. */
export function ClientFacingOutlet() {
  return (
    <ClientFacingGate>
      <Outlet />
    </ClientFacingGate>
  );
}
