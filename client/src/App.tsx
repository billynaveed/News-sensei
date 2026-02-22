import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { LockScreen } from "@/components/lock-screen";
import { useAuth } from "@/hooks/use-auth";
import Dashboard from "@/pages/dashboard";
import SettingsPage from "@/pages/settings";
import LogsPage from "@/pages/logs";
import DebugPage from "@/pages/debug";
import SavedLeadsPage from "@/pages/saved-leads";
import IpoFilingsPage from "@/pages/ipo-filings";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/saved-leads" component={SavedLeadsPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/logs" component={LogsPage} />
      <Route path="/debug" component={DebugPage} />
      <Route path="/ipo-filings" component={IpoFilingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const style = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  const { isAuthenticated, isSetup, isLoading, authenticate, register } = useAuth();

  if (isLoading) {
    return <div className="flex h-screen items-center justify-center bg-zinc-950" />;
  }

  // Show lock screen if credentials exist but not authenticated
  // If no credentials (not setup), allow through (first-use)
  if (!isAuthenticated) {
    return (
      <LockScreen
        isSetup={isSetup}
        onAuthenticate={authenticate}
        onRegister={register}
      />
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider style={style as React.CSSProperties}>
          <div className="flex h-screen w-full">
            <AppSidebar />
            <div className="flex flex-col flex-1 min-w-0">
              <header className="flex items-center justify-between gap-4 p-3 border-b border-border bg-background sticky top-0 z-50">
                <SidebarTrigger data-testid="button-sidebar-toggle" />
                <div className="flex items-center gap-2">
                  <ThemeToggle />
                </div>
              </header>
              <main className="flex-1 overflow-hidden bg-background">
                <Router />
              </main>
            </div>
          </div>
        </SidebarProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
