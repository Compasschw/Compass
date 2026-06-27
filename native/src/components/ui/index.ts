/**
 * Barrel export for the ui/ design-system component library.
 *
 * Import from this path rather than individual files:
 *   import { Card, Pill, StatTile } from '../components/ui';
 */

export { Card } from './Card';
export type { CardProps } from './Card';

export { Pill } from './Pill';
export type { PillProps, PillVariant, PillSize } from './Pill';

export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';

export { StatTile } from './StatTile';
export type { StatTileProps } from './StatTile';

export { RightRail } from './RightRail';
export type { RightRailProps } from './RightRail';

export { StickyActionBar } from './StickyActionBar';
export type { StickyActionBarProps, ActionItem, PrimaryAction } from './StickyActionBar';

export { RightDrawer } from './RightDrawer';
export type { RightDrawerProps } from './RightDrawer';

export { chwSidebarItems, memberSidebarItems } from './sidebarItems';
export type { SidebarItem, CHWSidebarItem, MemberSidebarItem } from './sidebarItems';

export { DashboardSidebar } from './DashboardSidebar';
export type { DashboardSidebarProps, UserBlock } from './DashboardSidebar';

export { AppShell } from './AppShell';
export type { AppShellProps, AppShellRole } from './AppShell';

export { SectionHeader } from './SectionHeader';
export type { SectionHeaderProps } from './SectionHeader';

export { PageWrap } from './PageWrap';
export type { PageWrapProps } from './PageWrap';

export { ResizableDivider } from './ResizableDivider';
export type { ResizableDividerProps } from './ResizableDivider';

export { ProfilePictureEditor } from './ProfilePictureEditor';
export type { ProfilePictureEditorProps } from './ProfilePictureEditor';

export { PressableCard } from './PressableCard';
export type { PressableCardProps } from './PressableCard';

export { StaggerList } from './StaggerList';
export type { StaggerListProps } from './StaggerList';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps, EmptyStateCTAProps } from './EmptyState';

// JourneyStepSpring is exported from its own feature barrel (components/journey)
// but also re-exported here for convenience so Wave 2 agents can import from
// the single ui/ barrel without needing to know the journey/ path.
export { JourneyStepSpring } from '../journey/JourneyStepSpring';
export type { JourneyStepSpringProps } from '../journey/JourneyStepSpring';

export { UpdateAvailableBanner } from './UpdateAvailableBanner';
