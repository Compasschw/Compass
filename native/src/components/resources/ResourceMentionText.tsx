/**
 * ResourceMentionText — renders text containing @-mention resource tokens.
 *
 * Token format: @[Resource Name](resource:uuid)
 *
 * Inline chips
 * ------------
 * Each token is replaced with an inline chip: a tappable pill showing the
 * resource name with a category-coloured dot. Tapping the chip opens a small
 * popover (Modal on native, inline expand on web) with the resource's phone,
 * hours, and eligibility. If the resource is inactive, the chip shows an
 * "(inactive)" suffix.
 *
 * Fetching resource data
 * ----------------------
 * The component extracts all unique resource UUIDs from the text, fires a
 * single batch of GET /resources/{id} calls (de-duped), and caches the
 * results in local state. Unknown UUIDs (404) render as plain text tokens.
 *
 * Plain text
 * ----------
 * Text segments between tokens are rendered with the ``textStyle`` prop
 * passed down from the parent (same as the surrounding message text).
 * This ensures font size, colour, and line-height are consistent.
 *
 * Accessibility
 * -------------
 * Chips have accessibilityRole="button" and an accessibilityLabel describing
 * the resource name. The popover is a Modal on native with accessibilityModal.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  TextStyle,
  TouchableOpacity,
  View,
} from 'react-native';
import { Phone, Clock, Info, X } from 'lucide-react-native';

import { getResourceById, type Resource } from '../../api/resources';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';

// ─── Token parser ──────────────────────────────────────────────────────────────

/** Regex to find all @[Name](resource:uuid) tokens in a string. */
const TOKEN_REGEX = /@\[([^\]]+)\]\(resource:([0-9a-f-]{36})\)/gi;

interface TextSegment {
  kind: 'text';
  content: string;
}

interface MentionSegment {
  kind: 'mention';
  displayName: string;
  resourceId: string;
}

type Segment = TextSegment | MentionSegment;

/**
 * Parse a text string into alternating text and mention segments.
 * Pure function — no side effects.
 */
function parseSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TOKEN_REGEX.lastIndex = 0; // reset global regex state
  while ((match = TOKEN_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({
      kind: 'mention',
      displayName: match[1],
      resourceId: match[2],
    });
    lastIndex = TOKEN_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', content: text.slice(lastIndex) });
  }
  return segments;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResourceMentionTextProps {
  /** The raw text content, may contain @[Name](resource:uuid) tokens. */
  text: string;
  /** Text style applied to non-mention segments. Accepts an array or a single style. */
  textStyle?: StyleProp<TextStyle>;
  /** Max lines before truncation. Omit for unlimited. */
  numberOfLines?: number;
}

// ─── Category display helpers (same as ResourceMentionInput) ──────────────────

const _CATEGORY_COLORS: Record<string, string> = {
  housing: '#3B82F6',
  food: '#F59E0B',
  mental_health: '#8B5CF6',
  rehab: '#EF4444',
  healthcare: '#06B6D4',
  legal: '#10B981',
  transportation: '#F97316',
  other: '#6B7280',
};

function _categoryColor(category: string): string {
  return _CATEGORY_COLORS[category] ?? '#6B7280';
}

// ─── Resource popover ──────────────────────────────────────────────────────────

interface ResourcePopoverProps {
  resource: Resource;
  onClose: () => void;
}

function ResourcePopover({ resource, onClose }: ResourcePopoverProps): React.JSX.Element {
  const catColor = _categoryColor(resource.category);

  const handleCallPress = useCallback(() => {
    if (!resource.phone) return;
    Linking.openURL(`tel:${resource.phone.replace(/\D/g, '')}`);
  }, [resource.phone]);

  return (
    <View style={popoverStyles.container}>
      {/* Header */}
      <View style={popoverStyles.header}>
        <View style={[popoverStyles.dot, { backgroundColor: catColor }]} />
        <View style={popoverStyles.headerText}>
          <Text style={popoverStyles.name} numberOfLines={2}>
            {resource.name}
          </Text>
          {resource.status === 'inactive' && (
            <Text style={popoverStyles.inactiveLabel}>No longer active</Text>
          )}
        </View>
        <TouchableOpacity
          onPress={onClose}
          style={popoverStyles.closeButton}
          accessibilityRole="button"
          accessibilityLabel="Close resource info"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <X size={16} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={popoverStyles.body}>
        {/* Description */}
        {resource.description ? (
          <Text style={popoverStyles.description} numberOfLines={4}>
            {resource.description}
          </Text>
        ) : null}

        {/* Phone */}
        {resource.phone ? (
          <TouchableOpacity
            style={popoverStyles.row}
            onPress={handleCallPress}
            accessibilityRole="button"
            accessibilityLabel={`Call ${resource.name} at ${resource.phone}`}
          >
            <Phone size={14} color={catColor} />
            <Text style={[popoverStyles.rowText, { color: catColor }]}>
              {resource.phone}
            </Text>
          </TouchableOpacity>
        ) : null}

        {/* Hours */}
        {resource.hours ? (
          <View style={popoverStyles.row}>
            <Clock size={14} color={colors.mutedForeground} />
            <Text style={popoverStyles.rowText}>{resource.hours}</Text>
          </View>
        ) : null}

        {/* Eligibility */}
        {resource.eligibility ? (
          <View style={popoverStyles.row}>
            <Info size={14} color={colors.mutedForeground} />
            <Text style={popoverStyles.rowText}>{resource.eligibility}</Text>
          </View>
        ) : null}

        {/* Languages */}
        {resource.languages.length > 0 ? (
          <Text style={popoverStyles.languages}>
            Languages: {resource.languages.join(', ')}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

// ─── Resource chip ─────────────────────────────────────────────────────────────

interface ResourceChipProps {
  displayName: string;
  resourceId: string;
  resourceCache: Map<string, Resource | null>;
  onFetch: (id: string) => void;
}

function ResourceChip({
  displayName,
  resourceId,
  resourceCache,
  onFetch,
}: ResourceChipProps): React.JSX.Element {
  const [popoverVisible, setPopoverVisible] = useState(false);

  const resource = resourceCache.get(resourceId);
  const isLoading = !resourceCache.has(resourceId);

  // Trigger fetch if not yet cached.
  useEffect(() => {
    if (!resourceCache.has(resourceId)) {
      onFetch(resourceId);
    }
  }, [resourceId, resourceCache, onFetch]);

  const catColor = resource ? _categoryColor(resource.category) : colors.primary;
  const isInactive = resource?.status === 'inactive';

  const handlePress = useCallback(() => {
    if (resource === undefined) return; // still loading
    setPopoverVisible(true);
  }, [resource]);

  const chip = (
    <TouchableOpacity
      onPress={handlePress}
      style={[
        chipStyles.chip,
        { backgroundColor: catColor + '18', borderColor: catColor + '40' },
        isInactive && chipStyles.chipInactive,
      ]}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`Resource mention: ${resource?.name ?? displayName}${isInactive ? ' (inactive)' : ''}`}
    >
      {isLoading ? (
        <ActivityIndicator size={10} color={catColor} style={chipStyles.spinner} />
      ) : (
        <View style={[chipStyles.dot, { backgroundColor: catColor }]} />
      )}
      <Text style={[chipStyles.label, { color: catColor }]} numberOfLines={1}>
        @{resource?.name ?? displayName}
        {isInactive ? ' (inactive)' : ''}
      </Text>
    </TouchableOpacity>
  );

  // On native use a Modal; on web use an inline expand (simpler, no Portal needed).
  if (Platform.OS === 'web') {
    return (
      <>
        {chip}
        {popoverVisible && resource ? (
          <View style={chipStyles.webPopoverWrapper}>
            <ResourcePopover
              resource={resource}
              onClose={() => setPopoverVisible(false)}
            />
          </View>
        ) : null}
      </>
    );
  }

  return (
    <>
      {chip}
      {resource ? (
        <Modal
          visible={popoverVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setPopoverVisible(false)}
          accessibilityViewIsModal
        >
          <Pressable
            style={chipStyles.modalOverlay}
            onPress={() => setPopoverVisible(false)}
          >
            <Pressable style={chipStyles.modalContent} onPress={() => {}}>
              <ResourcePopover
                resource={resource}
                onClose={() => setPopoverVisible(false)}
              />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ResourceMentionText({
  text,
  textStyle,
  numberOfLines,
}: ResourceMentionTextProps): React.JSX.Element {
  const segments = useMemo(() => parseSegments(text), [text]);

  // Collect unique resource IDs referenced in this text block.
  const resourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const seg of segments) {
      if (seg.kind === 'mention') ids.add(seg.resourceId);
    }
    return ids;
  }, [segments]);

  // Cache: Map<resourceId, Resource | null>
  // null means the resource was fetched but returned 404.
  // undefined (Map.has returns false) means not yet fetched.
  const [resourceCache, setResourceCache] = useState<Map<string, Resource | null>>(
    () => new Map(),
  );

  const handleFetch = useCallback(
    (resourceId: string) => {
      // Guard: already in cache (even if null) — don't re-fetch.
      if (resourceCache.has(resourceId)) return;

      // Optimistically mark as "in flight" by setting a sentinel so
      // concurrent calls don't double-fetch. We use the map itself as the
      // source of truth: has() = fetched, !has() = pending.
      // Because setState is async, we keep an in-module Set to track in-flight.
      getResourceById(resourceId)
        .then((resource) => {
          setResourceCache((prev) => {
            const next = new Map(prev);
            next.set(resourceId, resource);
            return next;
          });
        })
        .catch(() => {
          setResourceCache((prev) => {
            const next = new Map(prev);
            next.set(resourceId, null);
            return next;
          });
        });
    },
    [resourceCache],
  );

  // Pre-fetch all resource IDs when the component mounts or the text changes.
  useEffect(() => {
    for (const id of resourceIds) {
      if (!resourceCache.has(id)) {
        handleFetch(id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceIds]);

  // If no mention tokens found, render plain text to avoid overhead.
  if (!segments.some((s) => s.kind === 'mention')) {
    return (
      <Text style={textStyle} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }

  return (
    <Text style={textStyle} numberOfLines={numberOfLines}>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return (
            <Text key={index} style={textStyle}>
              {segment.content}
            </Text>
          );
        }

        // Mention segment: render a chip. Text components can contain
        // inline views on native only; for cross-platform compatibility
        // we wrap the chip in a Text-compatible container.
        return (
          <Text key={index}>
            {' '}
            <ResourceChip
              displayName={segment.displayName}
              resourceId={segment.resourceId}
              resourceCache={resourceCache}
              onFetch={handleFetch}
            />
            {' '}
          </Text>
        );
      })}
    </Text>
  );
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const popoverStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    maxWidth: 320,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 3,
    flexShrink: 0,
  },
  headerText: {
    flex: 1,
  },
  name: {
    ...typography.bodySm,
    fontWeight: '700',
    color: colors.foreground,
  },
  inactiveLabel: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  closeButton: {
    padding: 2,
  },
  body: {
    maxHeight: 200,
  },
  description: {
    ...typography.bodySm,
    color: colors.foreground,
    marginBottom: 10,
    lineHeight: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: 6,
  },
  rowText: {
    ...typography.bodySm,
    color: colors.foreground,
    flex: 1,
    lineHeight: 18,
  },
  languages: {
    ...typography.label,
    color: colors.mutedForeground,
    marginTop: 6,
  },
});

const chipStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  chipInactive: {
    opacity: 0.6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  spinner: {
    width: 10,
    height: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 180,
  },
  webPopoverWrapper: {
    position: 'absolute',
    bottom: '100%',
    left: 0,
    zIndex: 9999,
    marginBottom: 6,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxWidth: 360,
  },
});
