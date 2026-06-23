/**
 * CHWDocumentsScreen — member-grouped document management for CHWs.
 *
 * Organises all member documents by member so a CHW can quickly locate a
 * specific person's files when asked to produce documentation. Each member is
 * a collapsible section showing their full name and age as the identifier,
 * followed by their documents grouped by doc_type (id → income → address →
 * medical → other). Image files render as a thumbnail grid; PDFs and other
 * non-image files render as rows.
 *
 * Data flow: fan-out per caseload member (same N+1 pattern as before — a
 * dedicated GET /chw/documents aggregation endpoint is tracked as a follow-up).
 * Grouping is done with useMemo in each MemberDocumentGroup; the parent screen
 * maintains only the aggregated counts.
 *
 * Preserved features:
 *   - CHWUploadTrigger (member picker → doc type → file dialog)
 *   - Search: filters member groups by member name OR filename within
 *   - Per-doc Download (presigned URL), Delete (with confirm), thumbnail preview
 *   - EmptyState for zero documents across all members
 *   - Right-rail Quick Tip on web
 */

import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { useRoute, type RouteProp } from '@react-navigation/native';
import type { CHWTabParamList } from '../../navigation/CHWTabNavigator';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  type ViewStyle,
  type TextStyle,
  type ImageStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Calendar,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Download,
  FileBadge,
  FileSignature,
  FileScan,
  FileText,
  Filter,
  FolderOpen,
  Image as ImageIcon,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react-native';

import {
  AppShell,
  Card,
  EmptyState,
  PageHeader,
  Pill,
  PressableCard,
  RightDrawer,
  RightRail,
  StatTile,
} from '../../components/ui';
import { colors, numerals, spacing, radius, shadows } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useMemberDocuments,
  useMemberDocumentDelete,
  useMemberDocumentDownloadUrl,
  useChwMembers,
  type MemberDocumentData,
  type MembersRosterItem,
} from '../../hooks/useApiQueries';
import { useFileUpload, type DocumentType } from '../../hooks/useFileUpload';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentsRouteProp = RouteProp<CHWTabParamList, 'CHWDocuments'>;

type FilterType = 'all' | DocumentType;

// ─── Constants ────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<FilterType, string> = {
  all:     'All Types',
  id:      'Photo ID',
  income:  'Income',
  address: 'Address',
  medical: 'Medical',
  other:   'Other',
};

const DOC_TYPE_PILL: Record<DocumentType, 'blue' | 'purple' | 'emerald' | 'amber' | 'gray'> = {
  id:      'blue',
  income:  'purple',
  address: 'emerald',
  medical: 'amber',
  other:   'gray',
};

/** Display order for doc types within a member group. */
const DOC_TYPE_ORDER: DocumentType[] = ['id', 'income', 'address', 'medical', 'other'];

/** Document categories offered in the picker, in display order. */
const DOC_TYPE_OPTIONS: DocumentType[] = ['id', 'income', 'address', 'medical', 'other'];

/** Default collapse threshold — groups are collapsed by default when caseload > this. */
const COLLAPSE_THRESHOLD = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function showError(msg: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(msg);
  } else {
    Alert.alert('Error', msg);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Sort MembersRosterItem alphabetically by last name. Falls back to
 * displayName sort when the name has a single word.
 */
function sortMembersByLastName(members: MembersRosterItem[]): MembersRosterItem[] {
  return [...members].sort((a, b) => {
    const lastA = a.displayName.trim().split(' ').pop() ?? a.displayName;
    const lastB = b.displayName.trim().split(' ').pop() ?? b.displayName;
    return lastA.localeCompare(lastB);
  });
}

/**
 * Format an ISO date-of-birth as "May 09, 1990 (34 yrs)" — the canonical
 * patient-matching identifier shown in member group headers. Parses at UTC
 * noon to avoid timezone off-by-one-day. Returns '—' when DOB is absent.
 */
function formatDob(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [year, month, day] = iso.split('-').map(Number);
  const dob = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const formatted = dob.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  const hadBirthday =
    now.getUTCMonth() + 1 > month ||
    (now.getUTCMonth() + 1 === month && now.getUTCDate() >= day);
  if (!hadBirthday) age -= 1;
  return `${formatted} (${age} yrs)`;
}

// ─── DocTypeIcon ──────────────────────────────────────────────────────────────

function DocTypeIcon({
  docType,
  size = 16,
  color,
}: {
  docType: DocumentType;
  size?: number;
  color?: string;
}): React.JSX.Element {
  const c = color ?? colors.textSecondary;
  switch (docType) {
    case 'id':      return <FileSignature size={size} color={c} />;
    case 'income':  return <ClipboardList  size={size} color={c} />;
    case 'address': return <FileBadge      size={size} color={c} />;
    case 'medical': return <FileScan       size={size} color={c} />;
    default:        return <FileText       size={size} color={c} />;
  }
}

// ─── DownloadButton ───────────────────────────────────────────────────────────

function DownloadButton({ docId }: { docId: string }): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const q = useMemberDocumentDownloadUrl(docId, { enabled });

  const handlePress = useCallback(() => {
    if (q.isFetching) return;
    setEnabled(true);
  }, [q.isFetching]);

  useEffect(() => {
    if (!enabled || !q.data) return;
    void Linking.openURL(q.data.downloadUrl).catch(() =>
      showError('Could not open the file. Please try again.')
    );
    setEnabled(false);
  }, [enabled, q.data]);

  useEffect(() => {
    if (q.isError) {
      showError('Could not generate a download link.');
      setEnabled(false);
    }
  }, [q.isError]);

  return (
    <TouchableOpacity
      onPress={handlePress}
      accessible
      accessibilityLabel="Download document"
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={styles.actionButton}
    >
      {q.isFetching ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Download size={14} color={colors.textSecondary} />
      )}
    </TouchableOpacity>
  );
}

// ─── ImageThumbnailModal — full-size image viewer ─────────────────────────────

interface ImageThumbnailModalProps {
  docId: string;
  filename: string;
  onClose: () => void;
}

/**
 * Web variant: fetches the presigned URL and opens it in a new browser tab.
 * Rendered as a transient loading indicator while the URL resolves; calls
 * onClose immediately after opening (or on error) so the caller can clean up.
 */
function ImageThumbnailModalWeb({
  docId,
  onClose,
}: Omit<ImageThumbnailModalProps, 'filename'>): React.JSX.Element {
  const q = useMemberDocumentDownloadUrl(docId, { enabled: true });

  useEffect(() => {
    if (q.data?.downloadUrl) {
      window.open(q.data.downloadUrl, '_blank', 'noopener,noreferrer');
      onClose();
    }
  }, [q.data?.downloadUrl, onClose]);

  useEffect(() => {
    if (q.isError) onClose();
  }, [q.isError, onClose]);

  return (
    <View
      style={styles.fullImageLoadingWrap}
      accessible
      accessibilityLabel="Opening image"
    >
      <ActivityIndicator size="small" color={colors.primary} />
    </View>
  );
}

/**
 * Native variant: fetches the presigned URL and renders it full-screen in a
 * transparent Modal with a close button.
 */
function ImageThumbnailModalNative({
  docId,
  filename,
  onClose,
}: ImageThumbnailModalProps): React.JSX.Element {
  const q = useMemberDocumentDownloadUrl(docId, { enabled: true });

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      accessibilityLabel={`Full size view of ${filename}`}
    >
      <View style={styles.fullImageOverlay}>
        <TouchableOpacity
          style={styles.fullImageClose}
          onPress={onClose}
          accessible
          accessibilityRole="button"
          accessibilityLabel="Close image"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <X size={20} color="#ffffff" />
        </TouchableOpacity>

        {q.isLoading ? (
          <ActivityIndicator size="large" color="#ffffff" />
        ) : q.isError || !q.data?.downloadUrl ? (
          <Text style={styles.fullImageError}>Could not load image.</Text>
        ) : (
          <Image
            source={{ uri: q.data.downloadUrl }}
            style={styles.fullImage}
            resizeMode="contain"
            accessibilityLabel={`Full size: ${filename}`}
          />
        )}
      </View>
    </Modal>
  );
}

/** Platform-routing wrapper — always rendered on the same platform. */
function ImageThumbnailModal(props: ImageThumbnailModalProps): React.JSX.Element {
  if (Platform.OS === 'web') {
    return <ImageThumbnailModalWeb docId={props.docId} onClose={props.onClose} />;
  }
  return <ImageThumbnailModalNative {...props} />;
}

// ─── ImageTile — thumbnail in the grid ───────────────────────────────────────

interface ImageTileProps {
  doc: MemberDocumentData;
}

function ImageTile({ doc }: ImageTileProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const thumbQuery = useMemberDocumentDownloadUrl(doc.id, { enabled: !failed });
  const thumbUrl = !failed ? thumbQuery.data?.downloadUrl : undefined;
  const docType = doc.documentType as DocumentType;

  const handlePress = useCallback(() => {
    if (Platform.OS === 'web' && thumbUrl) {
      window.open(thumbUrl, '_blank', 'noopener,noreferrer');
    } else {
      setLightboxOpen(true);
    }
  }, [thumbUrl]);

  return (
    <>
      <TouchableOpacity
        onPress={handlePress}
        accessible
        accessibilityRole="button"
        accessibilityLabel={`View ${DOC_TYPE_LABELS[docType] ?? doc.documentType} image: ${doc.filename}`}
        style={styles.imageTile}
      >
        {thumbUrl ? (
          <Image
            source={{ uri: thumbUrl }}
            style={styles.imageTileImg}
            resizeMode="cover"
            onError={() => setFailed(true)}
            accessibilityLabel={`Thumbnail of ${doc.filename}`}
          />
        ) : thumbQuery.isFetching ? (
          <View style={styles.imageTilePlaceholder}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : (
          <View style={[styles.imageTilePlaceholder, { backgroundColor: '#7c3aed' }]}>
            <ImageIcon size={22} color="#ffffff" />
          </View>
        )}

        {/* Doc type label */}
        <View style={styles.imageTileLabel}>
          <Text style={styles.imageTileLabelText} numberOfLines={1}>
            {DOC_TYPE_LABELS[docType] ?? doc.documentType}
          </Text>
        </View>
      </TouchableOpacity>

      {lightboxOpen && Platform.OS !== 'web' && (
        <ImageThumbnailModal
          docId={doc.id}
          filename={doc.filename}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

// ─── DocumentRow — non-image (PDF/doc) row ────────────────────────────────────

interface DocumentRowProps {
  doc: MemberDocumentData;
  isAlt: boolean;
}

function DocumentRow({ doc, isAlt }: DocumentRowProps): React.JSX.Element {
  const deleteMutation = useMemberDocumentDelete(doc.memberId);
  const docType = doc.documentType as DocumentType;

  const handleDelete = useCallback(() => {
    const proceed = (): void => {
      deleteMutation.mutate(doc.id, {
        onError: () => showError('Could not delete the document.'),
      });
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(`Delete "${doc.filename}"?`)) proceed();
    } else {
      Alert.alert('Delete document', `Delete "${doc.filename}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: proceed },
      ]);
    }
  }, [doc, deleteMutation]);

  return (
    <View style={[styles.docRow, isAlt && styles.docRowAlt]}>
      {/* Icon badge */}
      <View style={styles.docRowIcon}>
        <DocTypeIcon docType={docType} size={16} color="#065f46" />
      </View>

      {/* File info */}
      <View style={styles.docRowInfo}>
        <Text style={styles.docRowFilename} numberOfLines={1}>
          {doc.filename}
        </Text>
        <View style={styles.docRowMeta}>
          <Pill variant={DOC_TYPE_PILL[docType] ?? 'gray'} size="sm">
            {DOC_TYPE_LABELS[docType] ?? doc.documentType}
          </Pill>
          <Text style={[styles.docRowMetaText, numerals.tabular as object]}>
            {formatDate(doc.uploadedAt)}
          </Text>
          <Text style={[styles.docRowMetaText, numerals.tabular as object]}>
            {formatBytes(doc.sizeBytes)}
          </Text>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.docRowActions}>
        <DownloadButton docId={doc.id} />
        <TouchableOpacity
          accessible
          accessibilityLabel={`Delete ${doc.filename}`}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={handleDelete}
          disabled={deleteMutation.isPending}
          style={styles.actionButton}
        >
          {deleteMutation.isPending ? (
            <ActivityIndicator size="small" color="#dc2626" />
          ) : (
            <Trash2 size={14} color={colors.textSecondary} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── MemberDocumentGroup ──────────────────────────────────────────────────────

/**
 * Fetches and renders all documents for a single caseload member, grouped into:
 *   1. Images: thumbnail grid
 *   2. Non-images: file rows sorted by doc_type (id, income, address, medical, other)
 *
 * Collapsible via PressableCard header. Reports its visible document count
 * to the parent screen for aggregated loading/empty-state logic.
 */
interface MemberDocumentGroupProps {
  member: MembersRosterItem;
  searchQuery: string;
  activeType: FilterType;
  defaultExpanded: boolean;
  onResult: (memberId: string, count: number | null) => void;
  /**
   * When truthy, force-expands this member's section once (deep-link entry).
   * The component only acts on a rising edge from false → true, then the
   * parent clears the flag so subsequent user interactions are unaffected.
   */
  forceExpanded?: boolean;
  /**
   * Called with the measured y-offset of this group's root View so the parent
   * screen can scroll to the right position after the roster renders.
   */
  onGroupLayout?: (memberId: string, y: number) => void;
}

function MemberDocumentGroup({
  member,
  searchQuery,
  activeType,
  defaultExpanded,
  onResult,
  forceExpanded = false,
  onGroupLayout,
}: MemberDocumentGroupProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const docsQuery = useMemberDocuments(member.id);

  // Honour the one-shot deep-link expansion signal from the parent screen.
  // React on a rising edge only — the parent clears forceExpanded after firing
  // so this doesn't fight manual collapse by the user on subsequent renders.
  const prevForceExpanded = useRef(false);
  useEffect(() => {
    if (forceExpanded && !prevForceExpanded.current) {
      setExpanded(true);
    }
    prevForceExpanded.current = forceExpanded;
  }, [forceExpanded]);
  const docs = docsQuery.data?.items ?? [];

  // Filter by search query and active type filter.
  const filtered = useMemo<MemberDocumentData[]>(() => {
    const lq = searchQuery.toLowerCase();
    return docs.filter((d) => {
      const typeMatch = activeType === 'all' || d.documentType === activeType;
      const nameMatch =
        searchQuery.length === 0 ||
        d.filename.toLowerCase().includes(lq) ||
        member.displayName.toLowerCase().includes(lq);
      return typeMatch && nameMatch;
    });
  }, [docs, searchQuery, activeType, member.displayName]);

  // Report load state and matching count to the parent.
  useEffect(() => {
    onResult(member.id, docsQuery.isLoading ? null : filtered.length);
  }, [member.id, docsQuery.isLoading, filtered.length, onResult]);

  // Hide members with zero matching documents unless we're actively searching
  // by member name (in that case, keep the empty group visible so the CHW
  // knows the member exists but has no docs of the filtered type).
  const memberNameMatches =
    searchQuery.length > 0 &&
    member.displayName.toLowerCase().includes(searchQuery.toLowerCase());

  if (!docsQuery.isLoading && filtered.length === 0 && !memberNameMatches) {
    return null;
  }

  // Separate images from non-images.
  const images = filtered.filter((d) => d.contentType.startsWith('image/'));
  const nonImages = filtered.filter((d) => !d.contentType.startsWith('image/'));

  // Sort non-images by doc_type in canonical order, then by upload date desc.
  const sortedNonImages = [...nonImages].sort((a, b) => {
    const orderA = DOC_TYPE_ORDER.indexOf(a.documentType as DocumentType);
    const orderB = DOC_TYPE_ORDER.indexOf(b.documentType as DocumentType);
    const typeSort = (orderA === -1 ? 99 : orderA) - (orderB === -1 ? 99 : orderB);
    if (typeSort !== 0) return typeSort;
    return new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime();
  });

  const docCount = filtered.length;
  // Canonical identifier line: full DOB when available, else age fallback,
  // followed by the masked CIN-last-4 for verbal verification.
  const dobLabel = member.dateOfBirth
    ? formatDob(member.dateOfBirth)
    : member.age != null
      ? `${member.age} yrs`
      : 'DOB not on file';

  return (
    <View
      style={styles.memberGroup}
      onLayout={(e) => onGroupLayout?.(member.id, e.nativeEvent.layout.y)}
    >
      {/* Collapsible header */}
      <PressableCard
        onPress={() => setExpanded((prev) => !prev)}
        accessibilityLabel={`${member.displayName}, ${docCount} document${docCount !== 1 ? 's' : ''}. ${expanded ? 'Collapse' : 'Expand'}`}
        style={styles.memberGroupHeader}
      >
        <View style={styles.memberGroupHeaderInner}>
          {/* Avatar */}
          <View style={styles.memberAvatar}>
            <Text style={styles.memberAvatarText}>{member.avatarInitials}</Text>
          </View>

          {/* Identity */}
          <View style={styles.memberGroupIdentity}>
            <Text style={styles.memberGroupName}>{member.displayName}</Text>
            <View style={styles.memberGroupSubRow}>
              <Calendar size={11} color={colors.textMuted} />
              <Text style={styles.memberGroupMeta}>
                {dobLabel} · {member.maskedId}
              </Text>
            </View>
          </View>

          {/* Right: pill + chevron */}
          <View style={styles.memberGroupRight}>
            {docsQuery.isLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Pill variant="emerald" size="sm">
                <Text style={[numerals.tabular as object]}>
                  {docCount} doc{docCount !== 1 ? 's' : ''}
                </Text>
              </Pill>
            )}
            <View style={styles.chevronWrap}>
              {expanded ? (
                <ChevronDown size={16} color={colors.textSecondary} />
              ) : (
                <ChevronRight size={16} color={colors.textSecondary} />
              )}
            </View>
          </View>
        </View>
      </PressableCard>

      {/* Expanded body */}
      {expanded && (
        <Card style={styles.memberGroupBody}>
          {docsQuery.isLoading ? (
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={styles.groupLoading}
              accessibilityLabel={`Loading documents for ${member.displayName}`}
            />
          ) : docsQuery.isError ? (
            <Text style={styles.groupError}>
              Could not load documents for this member. Please try again.
            </Text>
          ) : filtered.length === 0 ? (
            <Text style={styles.groupEmpty}>
              No documents match the current filter.
            </Text>
          ) : (
            <>
              {/* Image grid */}
              {images.length > 0 && (
                <View style={styles.imageSection}>
                  <View style={styles.imageSectionHeader}>
                    <ImageIcon size={13} color={colors.textSecondary} />
                    <Text style={styles.imageSectionLabel}>
                      Images ({images.length})
                    </Text>
                  </View>
                  <View style={styles.imageGrid}>
                    {images.map((doc) => (
                      <ImageTile key={doc.id} doc={doc} />
                    ))}
                  </View>
                </View>
              )}

              {/* Non-image rows */}
              {sortedNonImages.length > 0 && (
                <View style={[styles.docRowsSection, images.length > 0 && styles.docRowsSectionTop]}>
                  {sortedNonImages.map((doc, idx) => (
                    <DocumentRow key={doc.id} doc={doc} isAlt={idx % 2 === 1} />
                  ))}
                </View>
              )}
            </>
          )}
        </Card>
      )}
    </View>
  );
}

// ─── CHWUploadTrigger ─────────────────────────────────────────────────────────

/**
 * CHWUploadTrigger — upload a document on behalf of a member in the CHW's caseload.
 *
 * Flow:
 *   1. Tap "Upload for Member" → opens a drawer listing the CHW's caseload
 *      (`useChwMembers` → GET /chw/members), searchable by name or masked ID.
 *   2. Pick a member → pick a document type.
 *   3. The file dialog opens and the upload pipeline runs scoped to that member.
 */
function CHWUploadTrigger({
  onOpenChange,
}: {
  /** Notifies the parent screen when the picker drawer opens/closes so it can
   *  hide the redundant Quick Tip rail and avoid a stacking collision. */
  onOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedMember, setSelectedMember] = useState<MembersRosterItem | null>(null);
  const [memberId, setMemberId] = useState<string>('');
  const [docType, setDocType] = useState<DocumentType>('other');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectedMemberName = useRef<string>('');

  // Surface open state to the parent so it can hide the Quick Tip rail.
  useEffect(() => {
    onOpenChange?.(pickerOpen);
  }, [pickerOpen, onOpenChange]);

  const membersQuery = useChwMembers();

  const { upload, isUploading } = useFileUpload('member_document', {
    memberId,
    documentType: docType,
    onSuccess: (doc) => {
      const who = selectedMemberName.current || 'the member';
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        window.alert(`Uploaded "${doc.filename}" for ${who}.`);
      } else {
        Alert.alert('Document uploaded', `"${doc.filename}" was uploaded for ${who}.`);
      }
      setSelectedMember(null);
    },
    onError: (err) => showError(err.message),
  });

  const filteredMembers = useMemo(() => {
    const items = membersQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.maskedId.toLowerCase().includes(q),
    );
  }, [membersQuery.data, search]);

  const openPicker = useCallback(() => {
    if (isUploading) return;
    setSelectedMember(null);
    setSearch('');
    setPickerOpen(true);
  }, [isUploading]);

  const handleSelectDocType = useCallback(
    (dt: DocumentType) => {
      if (!selectedMember) return;
      setMemberId(selectedMember.id);
      setDocType(dt);
      selectedMemberName.current = selectedMember.displayName;
      setPickerOpen(false);
      if (Platform.OS === 'web') {
        setTimeout(() => fileInputRef.current?.click(), 50);
      } else {
        void upload();
      }
    },
    [selectedMember, upload],
  );

  const handleWebFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      if (event.target) event.target.value = '';
      void upload(file);
    },
    [upload],
  );

  return (
    <>
      <TouchableOpacity
        onPress={openPicker}
        disabled={isUploading}
        accessible
        accessibilityRole="button"
        accessibilityLabel="Upload document for a member"
        style={styles.uploadTrigger}
      >
        {isUploading ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Plus size={14} color="#ffffff" />
        )}
        <Text style={styles.uploadTriggerText}>
          {isUploading ? 'Uploading...' : 'Upload for Member'}
        </Text>
      </TouchableOpacity>

      <RightDrawer
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={selectedMember ? 'Choose document type' : 'Select a member'}
        subtitle={
          selectedMember
            ? `Uploading for ${selectedMember.displayName}`
            : 'Upload a document on behalf of someone in your caseload'
        }
      >
        {!selectedMember ? (
          <View style={styles.pickerBody}>
            <View style={styles.pickerSearchWrap}>
              <Search size={14} color={colors.textSecondary} />
              <TextInput
                style={styles.pickerSearchInput}
                placeholder="Search your caseload..."
                placeholderTextColor={colors.textMuted}
                value={search}
                onChangeText={setSearch}
                accessibilityLabel="Search caseload"
                autoFocus
              />
            </View>

            {membersQuery.isLoading ? (
              <ActivityIndicator
                size="small"
                color={colors.primary}
                style={styles.pickerSpinner}
              />
            ) : membersQuery.isError ? (
              <Text style={styles.pickerEmpty}>
                Could not load your caseload. Pull to retry.
              </Text>
            ) : filteredMembers.length === 0 ? (
              <Text style={styles.pickerEmpty}>
                {search.trim()
                  ? 'No members match your search.'
                  : 'No members in your caseload yet.'}
              </Text>
            ) : (
              <ScrollView
                style={styles.pickerList}
                keyboardShouldPersistTaps="handled"
              >
                {filteredMembers.map((m) => (
                  <TouchableOpacity
                    key={m.id}
                    style={styles.pickerMemberRow}
                    onPress={() => setSelectedMember(m)}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${m.displayName}`}
                  >
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberAvatarText}>
                        {m.avatarInitials}
                      </Text>
                    </View>
                    <View style={styles.pickerMemberRowText}>
                      <Text style={styles.pickerMemberName} numberOfLines={1}>
                        {m.displayName}
                      </Text>
                      <Text style={styles.pickerMemberMeta} numberOfLines={1}>
                        {m.maskedId}
                        {m.age != null ? ` · ${m.age} yrs` : ''}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>
        ) : (
          <View style={styles.pickerBody}>
            <TouchableOpacity
              style={styles.backRow}
              onPress={() => setSelectedMember(null)}
              accessible
              accessibilityRole="button"
              accessibilityLabel="Back to member list"
            >
              <Text style={styles.backText}>Back to members</Text>
            </TouchableOpacity>
            {DOC_TYPE_OPTIONS.map((dt) => (
              <TouchableOpacity
                key={dt}
                style={styles.docTypeRow}
                onPress={() => handleSelectDocType(dt)}
                accessible
                accessibilityRole="button"
                accessibilityLabel={`Upload ${DOC_TYPE_LABELS[dt]}`}
              >
                <DocTypeIcon docType={dt} size={18} />
                <Text style={styles.docTypeLabel}>{DOC_TYPE_LABELS[dt]}</Text>
                <Plus size={14} color={colors.textSecondary} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </RightDrawer>

      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/jpeg,image/png,image/heic,image/*"
          style={{ display: 'none' }}
          onChange={handleWebFileChange}
          aria-hidden="true"
        />
      )}
    </>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWDocumentsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<FilterType>('all');
  const [resultCounts, setResultCounts] = useState<Record<string, number | null>>({});
  // True while the "Upload for Member" drawer is open — hides the Quick Tip rail
  // so it can't stack over the drawer.
  const [uploadDrawerOpen, setUploadDrawerOpen] = useState(false);

  // ─── Deep-link: optional memberId route param ─────────────────────────────
  // useRoute is safe here: CHWDocumentsScreen is always mounted inside the
  // CHWTabNavigator, so a route is always present. The param may be undefined
  // when navigating from the plain Documents tab (no deep-link).
  const route = useRoute<DocumentsRouteProp>();
  const deepLinkMemberId = route.params?.memberId;

  // Track which member to force-expand. We use a ref to detect "applied once"
  // so re-renders after scroll don't re-trigger the expand or scroll jump.
  const [targetMemberId, setTargetMemberId] = useState<string | undefined>(
    deepLinkMemberId,
  );
  // Set to true once the scroll has been attempted so we don't loop.
  const deepLinkApplied = useRef(false);

  // Ref to the outer native ScrollView for scrollTo calls.
  const scrollViewRef = useRef<ScrollView>(null);

  // Per-member y-offsets measured via onLayout. Keyed by memberId.
  const memberYOffsets = useRef<Record<string, number>>({});

  const handleGroupLayout = useCallback((memberId: string, y: number) => {
    memberYOffsets.current[memberId] = y;
  }, []);

  const membersQuery = useChwMembers();
  const rawMembers = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);

  // Sort members alphabetically by last name for consistent "pull up when
  // requested" findability.
  const members = useMemo(() => sortMembersByLastName(rawMembers), [rawMembers]);

  // Collapse by default when the caseload exceeds the threshold.
  const defaultExpanded = members.length <= COLLAPSE_THRESHOLD;

  const handleResult = useCallback((memberId: string, count: number | null) => {
    setResultCounts((prev) =>
      prev[memberId] === count ? prev : { ...prev, [memberId]: count },
    );
  }, []);

  // ─── Deep-link effect: apply expand + scroll once roster is loaded ─────────
  // Keyed on members array and targetMemberId. Fires once the roster is
  // populated (members.length > 0) and a targetMemberId is set. After applying,
  // clears targetMemberId so this is a one-shot operation — manual interaction
  // within the screen is never overridden.
  useEffect(() => {
    if (!targetMemberId || deepLinkApplied.current || membersQuery.isLoading) {
      return;
    }
    const memberExists = members.some((m) => m.id === targetMemberId);
    if (!memberExists) return;

    deepLinkApplied.current = true;

    // Pre-fill the search filter as a fallback so the member is visible even
    // if the scroll measurement hasn't fired yet (web or first layout pass).
    const match = members.find((m) => m.id === targetMemberId);
    if (match) {
      // Only pre-fill if there's no existing search so we don't clobber CHW's
      // active search state when navigating back to the screen with a param.
      setQuery((prev) => (prev.trim() === '' ? match.displayName : prev));
    }

    // Schedule scroll after a short layout pass so onLayout measurements are
    // available. requestAnimationFrame is sufficient on native; on web, a
    // double-RAF ensures paint has completed.
    const doScroll = (): void => {
      const yOffset = memberYOffsets.current[targetMemberId];
      if (yOffset !== undefined && scrollViewRef.current) {
        scrollViewRef.current.scrollTo({ y: yOffset, animated: true });
      }
      // Clear target so re-navigation to the same screen without params
      // doesn't re-trigger (React Navigation keeps the component mounted).
      setTargetMemberId(undefined);
    };

    if (Platform.OS === 'web') {
      requestAnimationFrame(() => requestAnimationFrame(doScroll));
    } else {
      // On native, a single rAF is enough — layout events fire synchronously
      // before paint on the JS thread.
      requestAnimationFrame(doScroll);
    }
  }, [targetMemberId, members, membersQuery.isLoading]);

  // When the route params change (the CHW navigates to Documents again with a
  // new memberId without the screen unmounting), reset and re-arm the effect.
  useEffect(() => {
    if (deepLinkMemberId && deepLinkMemberId !== targetMemberId) {
      deepLinkApplied.current = false;
      memberYOffsets.current = {};
      setTargetMemberId(deepLinkMemberId);
      // Clear any stale search pre-fill so we start fresh for the new target.
      setQuery('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkMemberId]);

  const allSettled =
    members.length > 0 &&
    members.every((m) => typeof resultCounts[m.id] === 'number');

  const totalMatching = members.reduce(
    (sum, m) => sum + (resultCounts[m.id] ?? 0),
    0,
  );

  const isLoadingDocs =
    membersQuery.isLoading || (members.length > 0 && !allSettled);

  const isFiltering = query.trim().length > 0 || activeType !== 'all';
  const showEmpty = !isLoadingDocs && totalMatching === 0 && !isFiltering;
  const showNoMatch =
    !isLoadingDocs && totalMatching === 0 && isFiltering;

  const filterTypes = Object.keys(DOC_TYPE_LABELS) as FilterType[];

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const content = (
    <>
      <PageHeader
        title="Member Documents"
        subtitle="Documents across your caseload, organised by member"
        right={
          <View style={styles.headerRight}>
            <View style={styles.searchWrap}>
              <Search size={14} color={colors.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search members or files..."
                placeholderTextColor={colors.textMuted}
                value={query}
                onChangeText={setQuery}
                accessibilityLabel="Search members or documents"
              />
            </View>
            <CHWUploadTrigger onOpenChange={setUploadDrawerOpen} />
          </View>
        }
      />

      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.chipRow}
        contentContainerStyle={styles.chipRowContent}
        accessibilityLabel="Filter by document type"
      >
        {filterTypes.map((type) => (
          <TouchableOpacity
            key={type}
            onPress={() => setActiveType(type)}
            style={[
              styles.filterChip,
              activeType === type && styles.filterChipActive,
            ]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${DOC_TYPE_LABELS[type]}`}
            accessibilityState={{ selected: activeType === type }}
          >
            <Filter
              size={10}
              color={
                activeType === type ? colors.cardBg : colors.textSecondary
              }
            />
            <Text
              style={[
                styles.filterChipText,
                activeType === type && styles.filterChipTextActive,
              ]}
            >
              {DOC_TYPE_LABELS[type]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Body */}
      <View style={styles.bodyRow}>
        <View style={styles.groupsWrap}>
          {/* Global loading state while member list loads */}
          {membersQuery.isLoading && (
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={styles.globalLoading}
              accessibilityLabel="Loading members"
            />
          )}

          {/* Member groups */}
          {members.map((m) => (
            <MemberDocumentGroup
              key={m.id}
              member={m}
              searchQuery={query}
              activeType={activeType}
              defaultExpanded={defaultExpanded}
              onResult={handleResult}
              forceExpanded={targetMemberId === m.id}
              onGroupLayout={handleGroupLayout}
            />
          ))}

          {/* Per-member queries still settling */}
          {!membersQuery.isLoading && isLoadingDocs && (
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={styles.globalLoading}
              accessibilityLabel="Loading documents"
            />
          )}

          {/* Zero documents across entire caseload */}
          {showEmpty && (
            <EmptyState
              icon={FolderOpen}
              title="No documents yet"
              body="Use 'Upload for Member' to upload a document on behalf of someone in your caseload. It will appear here immediately."
              style={styles.emptyState}
            />
          )}

          {/* Search / filter returned nothing */}
          {showNoMatch && (
            <EmptyState
              icon={FileText}
              title="No matching documents"
              body="Try a different search term or document type filter."
              style={styles.emptyState}
            />
          )}
        </View>

        {Platform.OS === 'web' && !uploadDrawerOpen && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Quick Tip</Text>
              <Text style={styles.railBody}>
                Click "Upload for Member" and pick someone from your caseload
                to upload a document on their behalf.{'\n\n'}
                Members are sorted alphabetically and can be searched by name.
                The member sees the document immediately in their My Documents
                page.
              </Text>
            </Card>
          </RightRail>
        )}
      </View>
    </>
  );

  if (Platform.OS !== 'web') {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <ScrollView
          ref={scrollViewRef}
          contentContainerStyle={styles.nativeScroll}
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <AppShell
      role="chw"
      activeKey="documents"
      userBlock={{ initials: userInitials, name: userName ?? 'CHW', role: 'CHW' }}
    >
      {content}
    </AppShell>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const THUMB_SIZE = 80;
const THUMB_GAP = spacing.sm;

const styles = StyleSheet.create({
  // ─── Screen shell ──────────────────────────────────────────────────────────
  safeArea: {
    flex: 1,
    backgroundColor: colors.pageBg,
  } as ViewStyle,

  nativeScroll: {
    padding: spacing.lg,
    flexGrow: 1,
  } as ViewStyle,

  // ─── Header ────────────────────────────────────────────────────────────────
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    height: 36,
    gap: spacing.xs,
    minWidth: 240,
  } as ViewStyle,

  searchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    height: '100%',
    outlineStyle: 'none',
  } as unknown as TextStyle,

  // ─── Upload button ─────────────────────────────────────────────────────────
  uploadTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.md,
    height: 36,
  } as ViewStyle,

  uploadTriggerText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  } as TextStyle,

  // ─── Filter chips ──────────────────────────────────────────────────────────
  chipRow: {
    marginBottom: spacing.lg,
    flexGrow: 0,
    flexShrink: 0,
  } as ViewStyle,

  chipRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingRight: spacing.md,
  } as ViewStyle,

  filterChip: {
    alignSelf: 'flex-start',
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  filterChipActive: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  } as ViewStyle,

  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textSecondary,
  } as unknown as TextStyle,

  filterChipTextActive: {
    color: '#065f46',
  } as unknown as TextStyle,

  // ─── Body layout ───────────────────────────────────────────────────────────
  bodyRow: {
    flexDirection: 'row',
    gap: spacing.xl,
    alignItems: 'flex-start',
  } as ViewStyle,

  groupsWrap: {
    flex: 1,
    gap: spacing.md,
  } as ViewStyle,

  globalLoading: {
    paddingVertical: 32,
  } as ViewStyle,

  emptyState: {
    paddingTop: 32,
  } as ViewStyle,

  // ─── Member group ──────────────────────────────────────────────────────────
  memberGroup: {
    gap: 4,
  } as ViewStyle,

  memberGroupHeader: {
    padding: spacing.md,
    borderRadius: radius.xl,
  } as ViewStyle,

  memberGroupHeaderInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  } as ViewStyle,

  memberAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#ecfdf5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  memberAvatarText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#065f46',
  } as TextStyle,

  memberGroupIdentity: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  memberGroupName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 20,
  } as unknown as TextStyle,

  memberGroupSubRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  } as ViewStyle,

  memberGroupMeta: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 16,
  } as unknown as TextStyle,

  memberGroupRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0,
  } as ViewStyle,

  chevronWrap: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  // ─── Member group body card ────────────────────────────────────────────────
  memberGroupBody: {
    marginHorizontal: 2,
    overflow: 'hidden',
    borderRadius: radius.xl,
    padding: 0,
  } as ViewStyle,

  groupLoading: {
    paddingVertical: spacing.xl,
  } as ViewStyle,

  groupError: {
    fontSize: 13,
    color: '#dc2626',
    padding: spacing.lg,
    textAlign: 'center',
  } as unknown as TextStyle,

  groupEmpty: {
    fontSize: 13,
    color: colors.textSecondary,
    padding: spacing.lg,
    textAlign: 'center',
  } as unknown as TextStyle,

  // ─── Image grid section ────────────────────────────────────────────────────
  imageSection: {
    padding: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
  } as ViewStyle,

  imageSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: spacing.xs,
  } as ViewStyle,

  imageSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  } as unknown as TextStyle,

  imageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: THUMB_GAP,
  } as ViewStyle,

  // ─── Image tile ────────────────────────────────────────────────────────────
  imageTile: {
    width: THUMB_SIZE,
    gap: 4,
    // Minimum 44×44 touch target: tile width satisfies it; label adds height.
  } as ViewStyle,

  imageTileImg: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.md,
  } as ImageStyle,

  imageTilePlaceholder: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: radius.md,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  imageTileLabel: {
    width: THUMB_SIZE,
  } as ViewStyle,

  imageTileLabelText: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.textSecondary,
    textAlign: 'center',
  } as unknown as TextStyle,

  // ─── Non-image (PDF) rows section ─────────────────────────────────────────
  docRowsSection: {
    gap: 0,
  } as ViewStyle,

  docRowsSectionTop: {
    borderTopWidth: 1,
    borderTopColor: colors.cardBorder,
  } as ViewStyle,

  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 52,
  } as ViewStyle,

  docRowAlt: {
    backgroundColor: '#f9fafb',
  } as ViewStyle,

  docRowIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: '#ecfdf5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as ViewStyle,

  docRowInfo: {
    flex: 1,
    gap: 3,
  } as ViewStyle,

  docRowFilename: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 18,
  } as unknown as TextStyle,

  docRowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  } as ViewStyle,

  docRowMetaText: {
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 15,
  } as unknown as TextStyle,

  docRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0,
  } as ViewStyle,

  actionButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  // ─── Full-size image viewer ────────────────────────────────────────────────
  fullImageOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  } as ViewStyle,

  fullImageClose: {
    position: 'absolute',
    top: 52,
    right: 20,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 22,
    zIndex: 10,
  } as ViewStyle,

  fullImage: {
    width: '90%' as unknown as number,
    height: '80%' as unknown as number,
    borderRadius: radius.md,
  } as ImageStyle,

  fullImageLoadingWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  } as ViewStyle,

  fullImageError: {
    fontSize: 13,
    color: '#ffffff',
    textAlign: 'center',
  } as unknown as TextStyle,

  // ─── Rail ─────────────────────────────────────────────────────────────────
  railCard: {
    padding: spacing.lg,
    gap: spacing.md,
  } as ViewStyle,

  railTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  } as unknown as TextStyle,

  railBody: {
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 18,
  } as unknown as TextStyle,

  // ─── Upload picker drawer ──────────────────────────────────────────────────
  pickerBody: {
    gap: spacing.sm,
    padding: spacing.lg,
  } as ViewStyle,

  pickerSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    height: 38,
    gap: spacing.xs,
  } as ViewStyle,

  pickerSearchInput: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    height: '100%',
    outlineStyle: 'none',
  } as unknown as TextStyle,

  pickerSpinner: {
    marginTop: spacing.lg,
  } as ViewStyle,

  pickerEmpty: {
    fontSize: 13,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  } as unknown as TextStyle,

  pickerList: {
    maxHeight: 420,
  } as ViewStyle,

  pickerMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  } as ViewStyle,

  pickerMemberRowText: {
    flex: 1,
    gap: 1,
  } as ViewStyle,

  pickerMemberName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary,
  } as unknown as TextStyle,

  pickerMemberMeta: {
    fontSize: 11,
    color: colors.textSecondary,
  } as unknown as TextStyle,

  backRow: {
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  } as ViewStyle,

  backText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.primary,
  } as unknown as TextStyle,

  docTypeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    borderRadius: radius.md,
    backgroundColor: colors.cardBg,
  } as ViewStyle,

  docTypeLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  } as unknown as TextStyle,
});
