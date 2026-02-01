import { LayoutDashboard, Settings, Activity, TrendingUp, BookmarkCheck, Bug } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import type { Lead } from "@shared/schema";

const menuItems = [
  {
    title: "News Feed",
    url: "/",
    icon: LayoutDashboard,
  },
  {
    title: "Settings",
    url: "/settings",
    icon: Settings,
  },
  {
    title: "Scan Logs",
    url: "/logs",
    icon: Activity,
  },
  {
    title: "Debug",
    url: "/debug",
    icon: Bug,
  },
];

export function AppSidebar() {
  const [location] = useLocation();

  const { data: leads } = useQuery<Lead[]>({
    queryKey: ["/api/leads"],
  });

  const savedCount = leads?.filter(lead => lead.status === "saved").length ?? 0;

  return (
    <Sidebar>
      <SidebarHeader className="p-4 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-primary text-primary-foreground">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <span className="font-bold text-base tracking-tight">Lead Intel</span>
            <span className="text-xs text-muted-foreground">Private Banking</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    asChild
                    isActive={location === item.url}
                    data-testid={`nav-${item.title.toLowerCase().replace(" ", "-")}`}
                  >
                    <Link href={item.url}>
                      <item.icon className="h-4 w-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Quick Access</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={location === "/?filter=saved"}
                  data-testid="nav-saved-leads"
                >
                  <Link href="/?filter=saved">
                    <BookmarkCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span>Saved Leads</span>
                  </Link>
                </SidebarMenuButton>
                {savedCount > 0 && (
                  <SidebarMenuBadge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    {savedCount}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 border-t border-sidebar-border">
        <div className="text-xs text-muted-foreground">
          Southeast Asia Coverage
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
