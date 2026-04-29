/**
 * ChwMapWebView — non-web stub.
 *
 * The real implementation lives in `ChwMapWebView.web.tsx` and is loaded
 * by Metro on the web platform via the `.web.tsx` extension. Native
 * platforms (iOS/Android) render the existing AppleMaps/GoogleMaps view
 * inside MemberFindScreen, so this stub returns null and is never
 * actually rendered there.
 */

import type { ChwBrowseItem } from '../../hooks/useApiQueries';

interface Props {
  chws: ChwBrowseItem[];
  onMarkerPress: (chw: ChwBrowseItem) => void;
}

export function ChwMapWebView(_props: Props): null {
  return null;
}
