/**
 * CHWDocumentsScreen — caseload member list -> per-member document repository.
 *
 * Landing view is the CHW's searchable caseload member list (reusing
 * useChwMembers, same as the upload picker). Selecting a member opens THEIR
 * repository: uploaded documents (useMemberDocuments) merged with chat file
 * attachments (useMemberChatAttachments) from every conversation the CALLING
 * CHW has with that member, date-sorted newest-first. Each row shows its
 * source ("Uploaded" vs "From chat") plus date and size. This replaces the
 * previous collapsible-groups feed that fanned out a useMemberDocuments call
 * per caseload member on load (N+1) and never surfaced chat attachments at
 * all — chat-shared files appeared nowhere in the product.
 *
 * Preserved / carried forward:
 *   - CHWUploadTrigger (member picker -> doc type -> file dialog); now also
 *     launchable from inside a member's repository, which preselects that
 *     member and skips the picker step.
 *   - Search: filters the landing member list by name or masked ID.
 *   - Per-doc Download (presigned URL), Delete (uploaded docs only, with
 *     confirm), thumbnail preview for images.
 *   - EmptyState variants, Right-rail Quick Tip on web.
 *
 * Screen-local state only — the repository "back to members" control does
 * NOT touch the navigator; selecting/deselecting a member is a local view
 * swap so the tab's scroll position and the caseload list resist reloads.
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
  Pressable,
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
  ArrowLeft,
  Calendar,
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
  MessageSquare,
  Plus,
  Search,
  Trash2,
  Upload,
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
} from '../../components/ui';
import { colors, numerals, spacing, radius } from '../../theme/tokens';
import { useAuth } from '../../context/AuthContext';
import {
  useMemberDocuments,
  useMemberDocumentDelete,
  useMemberDocumentDownloadUrl,
  useMemberChatAttachments,
  useMessageAttachmentDownloadUrl,
  useChwMembers,
  type MemberDocumentData,
  type MemberChatAttachmentData,
  type MembersRosterItem,
} from '../../hooks/useApiQueries';
import { useFileUpload, type DocumentType } from '../../hooks/useFileUpload';

// ─── Types ────────────────────────────────────────────────────────────────────

type DocumentsRouteProp = RouteProp<CHWTabParamList, 'CHWDocuments'>;

type FilterType = 'all' | DocumentType | 'chat';

/** Unified row shape merging an uploaded MemberDocument with a chat FileAttachment. */
interface RepositoryRow {
  /** MemberDocument.id or the owning Message.id — unique within source. */
  id: string;
  source: 'uploaded' | 'chat';
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** ISO timestamp — uploadedAt (docs) or createdAt (chat). */
  date: string;
  /** Present for uploaded docs only. */
  documentType?: DocumentType;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  id:      'Photo ID',
  income:  'Income',
  address: 'Address',
  medical: 'Medical',
  other:   'Other',
};

const FILTER_LABELS: Record<FilterType, string> = {
  all:     'All Types',
  id:      'Photo ID',
  income:  'Income',
  address: 'Address',
  medical: 'Medical',
  other:   'Other',
  chat:    'From Chat',
};

const DOC_TYPE_PILL: Record<DocumentType, 'blue' | 'purple' | 'emerald' | 'amber' | 'gray'> = {
  id:      'blue',
  income:  'purple',
  address: 'emerald',
  medical: 'amber',
  other:   'gray',
};

/** Document categories offered in the upload picker, in display order. */
const DOC_TYPE_OPTIONS: DocumentType[] = ['id', 'income', 'address', 'medical', 'other'];

/** Filter chip display order on the repository view. */
const FILTER_ORDER: FilterType[] = ['all', 'id', 'income', 'address', 'medical', 'other', 'chat'];

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

/** Sort MembersRosterItem alphabetically by last name. */
function sortMembersByLastName(members: MembersRosterItem[]): MembersRosterItem[] {
  return [...members].sort((a, b) => {
    const lastA = a.displayName.trim().split(' ').pop() ?? a.displayName;
    const lastB = b.displayName.trim().split(' ').pop() ?? b.displayName;
    return lastA.localeCompare(lastB);
  });
}

/**
 * Format an ISO date-of-birth as "May 09, 1990 (34 yrs)" — the canonical
 * patient-matching identifier. Parses at UTC noon to avoid timezone
 * off-by-one-day. Returns '—' when DOB is absent.
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

/** Merge uploaded documents + chat attachments into a single date-sorted list. */
function mergeRepositoryRows(
  docs: MemberDocumentData[],
  attachments: MemberChatAttachmentData[],
): RepositoryRow[] {
  const docRows: RepositoryRow[] = docs.map((d) => ({
    id: d.id,
    source: 'uploaded',
    filename: d.filename,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    date: d.uploadedAt,
    documentType: d.documentType as DocumentType,
  }));
  const attachmentRows: RepositoryRow[] = attachments.map((a) => ({
    id: a.id,
    source: 'chat',
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    date: a.createdAt,
  }));
  return [...docRows, ...attachmentRows].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
}

// ─── DocTypeIcon ──────────────────────────────────────────────────────────────

function DocTypeIcon({
  docType,
  size = 16,
  color,
}: {
  docType: DocumentType | undefined;
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

// ─── DownloadButton — uploaded documents ──────────────────────────────────────

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

// ─── ChatAttachmentDownloadButton — chat attachments ──────────────────────────

/**
 * Download button for a chat-sourced attachment. Reuses the message
 * attachment-url presigned endpoint (there is no MemberDocument row for
 * chat files, so useMemberDocumentDownloadUrl does not apply).
 */
function ChatAttachmentDownloadButton({ messageId }: { messageId: string }): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const q = useMessageAttachmentDownloadUrl(messageId, { enabled });

  const handlePress = useCallback(() => {
    if (q.isFetching) return;
    setEnabled(true);
  }, [q.isFetching]);

  useEffect(() => {
    if (!enabled || !q.data) return;
    void Linking.openURL(q.data.url).catch(() =>
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
      accessibilityLabel="Download file shared in chat"
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

// ─── ImageThumbnailModal — full-size image viewer (uploaded docs only) ────────

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

// ─── ImageTile — thumbnail in the grid (uploaded docs only) ───────────────────

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

// ─── RepositoryRowView — a single row in the merged repository list ──────────

interface RepositoryRowViewProps {
  row: RepositoryRow;
  memberId: string;
  isAlt: boolean;
}

function RepositoryRowView({ row, memberId, isAlt }: RepositoryRowViewProps): React.JSX.Element {
  const deleteMutation = useMemberDocumentDelete(memberId);
  const isUploaded = row.source === 'uploaded';

  const handleDelete = useCallback(() => {
    const proceed = (): void => {
      deleteMutation.mutate(row.id, {
        onError: () => showError('Could not delete the document.'),
      });
    };
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm(`Delete "${row.filename}"?`)) proceed();
    } else {
      Alert.alert('Delete document', `Delete "${row.filename}"?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: proceed },
      ]);
    }
  }, [row, deleteMutation]);

  return (
    <View style={[styles.docRow, isAlt && styles.docRowAlt]}>
      {/* Icon badge */}
      <View style={[styles.docRowIcon, !isUploaded && styles.docRowIconChat]}>
        {isUploaded ? (
          <DocTypeIcon docType={row.documentType} size={16} color="#065f46" />
        ) : (
          <MessageSquare size={16} color="#1d4ed8" />
        )}
      </View>

      {/* File info */}
      <View style={styles.docRowInfo}>
        <Text style={styles.docRowFilename} numberOfLines={1}>
          {row.filename}
        </Text>
        <View style={styles.docRowMeta}>
          {isUploaded ? (
            <Pill variant={DOC_TYPE_PILL[row.documentType as DocumentType] ?? 'gray'} size="sm">
              {DOC_TYPE_LABELS[row.documentType as DocumentType] ?? row.documentType}
            </Pill>
          ) : (
            <Pill variant="blue" size="sm">
              From chat
            </Pill>
          )}
          <Text style={[styles.docRowMetaText, numerals.tabular as object]}>
            {formatDate(row.date)}
          </Text>
          <Text style={[styles.docRowMetaText, numerals.tabular as object]}>
            {formatBytes(row.sizeBytes)}
          </Text>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.docRowActions}>
        {isUploaded ? (
          <DownloadButton docId={row.id} />
        ) : (
          <ChatAttachmentDownloadButton messageId={row.id} />
        )}
        {isUploaded && (
          <TouchableOpacity
            accessible
            accessibilityLabel={`Delete ${row.filename}`}
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
        )}
      </View>
    </View>
  );
}

// ─── Picker row sub-components (upload trigger's member/doc-type drawer) ─────

/**
 * PickerMemberRow — a single selectable member row in the upload-picker drawer.
 *
 * Uses `Pressable` instead of `TouchableOpacity` so we can attach `onHoverIn`/
 * `onHoverOut` for the web cursor and hover-tint affordance. `TouchableOpacity`
 * does not expose those handlers on react-native-web.
 *
 * Each row owns its own `hovered` state to avoid O(n) re-renders of siblings.
 */
function PickerMemberRow({
  member,
  onSelect,
}: {
  member: MembersRosterItem;
  onSelect: (member: MembersRosterItem) => void;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      onPress={() => onSelect(member)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Select ${member.displayName}`}
      style={[
        styles.pickerMemberRow,
        hovered && styles.pickerMemberRowHover,
      ]}
    >
      <View style={styles.memberAvatar}>
        <Text style={styles.memberAvatarText}>{member.avatarInitials}</Text>
      </View>
      <View style={styles.pickerMemberRowText}>
        <Text style={styles.pickerMemberName} numberOfLines={1}>
          {member.displayName}
        </Text>
        <Text style={styles.pickerMemberMeta} numberOfLines={1}>
          {member.maskedId}
          {member.age != null ? ` · ${member.age} yrs` : ''}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * PickerDocTypeRow — a single selectable document-type row in the upload-picker
 * drawer. Uses the same `Pressable` + hover-state pattern as `PickerMemberRow`.
 */
function PickerDocTypeRow({
  docType,
  onSelect,
}: {
  docType: DocumentType;
  onSelect: (docType: DocumentType) => void;
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      onPress={() => onSelect(docType)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Upload ${DOC_TYPE_LABELS[docType]}`}
      style={[
        styles.docTypeRow,
        hovered && styles.docTypeRowHover,
      ]}
    >
      <DocTypeIcon docType={docType} size={18} />
      <Text style={styles.docTypeLabel}>{DOC_TYPE_LABELS[docType]}</Text>
      <Plus size={14} color={colors.textSecondary} />
    </Pressable>
  );
}

// ─── MemberListRow — landing view row (member list → opens repository) ───────

interface MemberListRowProps {
  member: MembersRosterItem;
  onSelect: (member: MembersRosterItem) => void;
}

/**
 * A single row in the landing caseload list. Visually mirrors PickerMemberRow
 * (avatar + name + masked id/age) but is the primary navigation surface for
 * this screen, not a drawer picker — tapping opens the member's repository.
 */
function MemberListRow({ member, onSelect }: MemberListRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const dobLabel = member.dateOfBirth
    ? formatDob(member.dateOfBirth)
    : member.age != null
      ? `${member.age} yrs`
      : 'DOB not on file';

  return (
    <Pressable
      onPress={() => onSelect(member)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`Open documents for ${member.displayName}`}
      style={[styles.memberListRow, hovered && styles.memberListRowHover]}
    >
      <View style={styles.memberAvatar}>
        <Text style={styles.memberAvatarText}>{member.avatarInitials}</Text>
      </View>
      <View style={styles.memberListRowText}>
        <Text style={styles.memberListRowName} numberOfLines={1}>
          {member.displayName}
        </Text>
        <View style={styles.memberGroupSubRow}>
          <Calendar size={11} color={colors.textMuted} />
          <Text style={styles.memberGroupMeta}>
            {dobLabel} · {member.maskedId}
          </Text>
        </View>
      </View>
      <ChevronRight size={16} color={colors.textSecondary} />
    </Pressable>
  );
}

// ─── CHWUploadTrigger ─────────────────────────────────────────────────────────

/**
 * CHWUploadTrigger — upload a document on behalf of a member in the CHW's caseload.
 *
 * Flow:
 *   1. Tap "Upload for Member" → opens a drawer listing the CHW's caseload
 *      (`useChwMembers` → GET /chw/members), searchable by name or masked ID —
 *      UNLESS `preselectedMember` is supplied, in which case the picker step
 *      is skipped entirely and the drawer opens straight to doc-type choice
 *      (used when launched from inside a member's repository view, where the
 *      member is already known).
 *   2. Pick a member (or skip, if preselected) → pick a document type.
 *   3. The file dialog opens and the upload pipeline runs scoped to that member.
 */
function CHWUploadTrigger({
  preselectedMember = null,
  label = 'Upload for Member',
  onOpenChange,
}: {
  /** When set, the member-picker step is skipped and this member is used. */
  preselectedMember?: MembersRosterItem | null;
  /** Trigger button label — repository view uses a shorter label. */
  label?: string;
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
    // Preselected (repository view): jump straight to doc-type choice.
    setSelectedMember(preselectedMember ?? null);
    setSearch('');
    setPickerOpen(true);
  }, [isUploading, preselectedMember]);

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

  // If launched from a repository and the picker closes without a selection
  // (e.g. backdrop dismiss), reset back to the preselected member rather than
  // null so re-opening doesn't unexpectedly show the full caseload picker.
  const handleClose = useCallback(() => {
    setPickerOpen(false);
    setSelectedMember(preselectedMember ?? null);
  }, [preselectedMember]);

  return (
    <>
      <TouchableOpacity
        onPress={openPicker}
        disabled={isUploading}
        accessible
        accessibilityRole="button"
        accessibilityLabel={
          preselectedMember
            ? `Upload document for ${preselectedMember.displayName}`
            : 'Upload document for a member'
        }
        style={styles.uploadTrigger}
      >
        {isUploading ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Plus size={14} color="#ffffff" />
        )}
        <Text style={styles.uploadTriggerText}>
          {isUploading ? 'Uploading...' : label}
        </Text>
      </TouchableOpacity>

      <RightDrawer
        isOpen={pickerOpen}
        onClose={handleClose}
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
                  <PickerMemberRow
                    key={m.id}
                    member={m}
                    onSelect={setSelectedMember}
                  />
                ))}
              </ScrollView>
            )}
          </View>
        ) : (
          <View style={styles.pickerBody}>
            {!preselectedMember && (
              <TouchableOpacity
                style={styles.backRow}
                onPress={() => setSelectedMember(null)}
                accessible
                accessibilityRole="button"
                accessibilityLabel="Back to member list"
              >
                <Text style={styles.backText}>Back to members</Text>
              </TouchableOpacity>
            )}
            {DOC_TYPE_OPTIONS.map((dt) => (
              <PickerDocTypeRow
                key={dt}
                docType={dt}
                onSelect={handleSelectDocType}
              />
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

// ─── MemberRepository — per-member repository view ────────────────────────────

interface MemberRepositoryProps {
  member: MembersRosterItem;
  onBack: () => void;
  uploadDrawerOpen: boolean;
  onUploadDrawerOpenChange: (open: boolean) => void;
}

function MemberRepository({
  member,
  onBack,
  uploadDrawerOpen,
  onUploadDrawerOpenChange,
}: MemberRepositoryProps): React.JSX.Element {
  const [activeFilter, setActiveFilter] = useState<FilterType>('all');
  const docsQuery = useMemberDocuments(member.id);
  const attachmentsQuery = useMemberChatAttachments(member.id);

  const docs = docsQuery.data?.items ?? [];
  const attachments = attachmentsQuery.data?.items ?? [];

  const isLoading = docsQuery.isLoading || attachmentsQuery.isLoading;
  // Both sources have independent error states; only block the whole view when
  // BOTH fail — a single source failing still shows the other's data.
  const isError = docsQuery.isError && attachmentsQuery.isError;

  const allRows = useMemo(() => mergeRepositoryRows(docs, attachments), [docs, attachments]);

  const filteredRows = useMemo(() => {
    if (activeFilter === 'all') return allRows;
    if (activeFilter === 'chat') return allRows.filter((r) => r.source === 'chat');
    return allRows.filter((r) => r.source === 'uploaded' && r.documentType === activeFilter);
  }, [allRows, activeFilter]);

  // Image grid: uploaded image documents only (chat attachments never render
  // as thumbnails — they have no MemberDocument row for the thumbnail hook).
  const imageDocs = useMemo(
    () =>
      docs.filter(
        (d) =>
          d.contentType.startsWith('image/') &&
          (activeFilter === 'all' || activeFilter === d.documentType),
      ),
    [docs, activeFilter],
  );
  const imageDocIds = useMemo(() => new Set(imageDocs.map((d) => d.id)), [imageDocs]);
  const nonImageRows = useMemo(
    () => filteredRows.filter((r) => !(r.source === 'uploaded' && imageDocIds.has(r.id))),
    [filteredRows, imageDocIds],
  );

  const totalCount = allRows.length;
  const filteredCount = filteredRows.length;
  const isFiltering = activeFilter !== 'all';
  const showEmpty = !isLoading && !isError && totalCount === 0;
  const showNoMatch = !isLoading && !isError && totalCount > 0 && filteredCount === 0 && isFiltering;

  return (
    <>
      <PageHeader
        title={member.displayName}
        subtitle="Uploaded documents and files shared in chat"
        right={
          <View style={styles.headerRight}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={onBack}
              accessible
              accessibilityRole="button"
              accessibilityLabel="Back to member list"
            >
              <ArrowLeft size={14} color={colors.textSecondary} />
              <Text style={styles.backButtonText}>Members</Text>
            </TouchableOpacity>
            <CHWUploadTrigger
              preselectedMember={member}
              label="Upload for Member"
              onOpenChange={onUploadDrawerOpenChange}
            />
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
        {FILTER_ORDER.map((type) => (
          <TouchableOpacity
            key={type}
            onPress={() => setActiveFilter(type)}
            style={[
              styles.filterChip,
              activeFilter === type && styles.filterChipActive,
            ]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${FILTER_LABELS[type]}`}
            accessibilityState={{ selected: activeFilter === type }}
          >
            {type === 'chat' ? (
              <MessageSquare
                size={10}
                color={activeFilter === type ? colors.cardBg : colors.textSecondary}
              />
            ) : (
              <Filter
                size={10}
                color={activeFilter === type ? colors.cardBg : colors.textSecondary}
              />
            )}
            <Text
              style={[
                styles.filterChipText,
                activeFilter === type && styles.filterChipTextActive,
              ]}
            >
              {FILTER_LABELS[type]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Body */}
      <View style={styles.bodyRow}>
        <View style={styles.groupsWrap}>
          {isLoading && (
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={styles.globalLoading}
              accessibilityLabel={`Loading documents for ${member.displayName}`}
            />
          )}

          {isError && (
            <Text style={styles.groupError}>
              Could not load documents for this member. Please try again.
            </Text>
          )}

          {!isLoading && !isError && filteredRows.length > 0 && (
            <Card style={styles.memberGroupBody}>
              {/* Image grid (uploaded images only) */}
              {imageDocs.length > 0 && (
                <View style={styles.imageSection}>
                  <View style={styles.imageSectionHeader}>
                    <ImageIcon size={13} color={colors.textSecondary} />
                    <Text style={styles.imageSectionLabel}>
                      Images ({imageDocs.length})
                    </Text>
                  </View>
                  <View style={styles.imageGrid}>
                    {imageDocs.map((doc) => (
                      <ImageTile key={doc.id} doc={doc} />
                    ))}
                  </View>
                </View>
              )}

              {/* Merged, date-sorted rows (everything except image docs shown above) */}
              {nonImageRows.length > 0 && (
                <View style={[styles.docRowsSection, imageDocs.length > 0 && styles.docRowsSectionTop]}>
                  {nonImageRows.map((row, idx) => (
                    <RepositoryRowView
                      key={`${row.source}-${row.id}`}
                      row={row}
                      memberId={member.id}
                      isAlt={idx % 2 === 1}
                    />
                  ))}
                </View>
              )}
            </Card>
          )}

          {showEmpty && (
            <EmptyState
              icon={FolderOpen}
              title="No documents yet"
              body={`No documents yet for ${member.displayName} — upload one or files shared in chat will appear here.`}
              style={styles.emptyState}
            />
          )}

          {showNoMatch && (
            <EmptyState
              icon={FileText}
              title="No matching documents"
              body="Try a different document type filter."
              style={styles.emptyState}
            />
          )}
        </View>

        {Platform.OS === 'web' && !uploadDrawerOpen && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Quick Tip</Text>
              <Text style={styles.railBody}>
                This repository merges documents uploaded on {member.displayName}
                &apos;s behalf with files they&apos;ve shared in chat.{'\n\n'}
                Use the &quot;From Chat&quot; filter to see only chat-shared files,
                or a document-type filter to narrow uploaded documents.
              </Text>
            </Card>
          </RightRail>
        )}
      </View>
    </>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CHWDocumentsScreen(): React.JSX.Element {
  const { userName } = useAuth();
  const [query, setQuery] = useState('');
  // Selected member drives landing (null) vs repository (set) — screen-local
  // state only; no navigator params are used for this view swap.
  const [selectedMember, setSelectedMember] = useState<MembersRosterItem | null>(null);
  // True while an upload drawer is open — hides the Quick Tip rail so it
  // can't stack over the drawer.
  const [uploadDrawerOpen, setUploadDrawerOpen] = useState(false);

  // ─── Deep-link: optional memberId route param ─────────────────────────────
  // useRoute is safe here: CHWDocumentsScreen is always mounted inside the
  // CHWTabNavigator, so a route is always present. The param may be undefined
  // when navigating from the plain Documents tab (no deep-link).
  const route = useRoute<DocumentsRouteProp>();
  const deepLinkMemberId = route.params?.memberId;
  const deepLinkApplied = useRef(false);

  const membersQuery = useChwMembers();
  const rawMembers = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const members = useMemo(() => sortMembersByLastName(rawMembers), [rawMembers]);

  // ─── Deep-link effect: auto-open the target member's repository once ──────
  useEffect(() => {
    if (!deepLinkMemberId || deepLinkApplied.current || membersQuery.isLoading) {
      return;
    }
    const match = members.find((m) => m.id === deepLinkMemberId);
    if (!match) return;
    deepLinkApplied.current = true;
    setSelectedMember(match);
  }, [deepLinkMemberId, members, membersQuery.isLoading]);

  // Re-arm if the route param changes to a different member while mounted
  // (React Navigation keeps the component mounted across tab re-entry).
  const prevDeepLinkMemberId = useRef(deepLinkMemberId);
  useEffect(() => {
    if (deepLinkMemberId && deepLinkMemberId !== prevDeepLinkMemberId.current) {
      deepLinkApplied.current = false;
    }
    prevDeepLinkMemberId.current = deepLinkMemberId;
  }, [deepLinkMemberId]);

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        m.maskedId.toLowerCase().includes(q),
    );
  }, [members, query]);

  const handleSelectMember = useCallback((member: MembersRosterItem) => {
    setSelectedMember(member);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedMember(null);
  }, []);

  const userInitials = (userName ?? 'CHW')
    .split(' ')
    .map((n) => n[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const isLoadingMembers = membersQuery.isLoading;
  const showEmptyRoster = !isLoadingMembers && members.length === 0;
  const showNoMatch = !isLoadingMembers && members.length > 0 && filteredMembers.length === 0;

  const content = selectedMember ? (
    <MemberRepository
      member={selectedMember}
      onBack={handleBack}
      uploadDrawerOpen={uploadDrawerOpen}
      onUploadDrawerOpenChange={setUploadDrawerOpen}
    />
  ) : (
    <>
      <PageHeader
        title="Member Documents"
        subtitle="Select a member to view their document repository"
        right={
          <View style={styles.headerRight}>
            <View style={styles.searchWrap}>
              <Search size={14} color={colors.textSecondary} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search your caseload..."
                placeholderTextColor={colors.textMuted}
                value={query}
                onChangeText={setQuery}
                accessibilityLabel="Search caseload members"
              />
            </View>
            <CHWUploadTrigger onOpenChange={setUploadDrawerOpen} />
          </View>
        }
      />

      <View style={styles.bodyRow}>
        <View style={styles.groupsWrap}>
          {isLoadingMembers && (
            <ActivityIndicator
              size="small"
              color={colors.primary}
              style={styles.globalLoading}
              accessibilityLabel="Loading members"
            />
          )}

          {membersQuery.isError && (
            <Text style={styles.groupError}>
              Could not load your caseload. Please try again.
            </Text>
          )}

          {!isLoadingMembers && !membersQuery.isError && (
            <Card style={styles.memberListCard}>
              {filteredMembers.map((m) => (
                <MemberListRow key={m.id} member={m} onSelect={handleSelectMember} />
              ))}
            </Card>
          )}

          {showEmptyRoster && (
            <EmptyState
              icon={Upload}
              title="No members yet"
              body="Members you have an active relationship with will appear here. Once they do, you can view and upload documents on their behalf."
              style={styles.emptyState}
            />
          )}

          {showNoMatch && (
            <EmptyState
              icon={Search}
              title="No matching members"
              body="Try a different search term."
              style={styles.emptyState}
            />
          )}
        </View>

        {Platform.OS === 'web' && !uploadDrawerOpen && (
          <RightRail>
            <Card style={styles.railCard}>
              <Text style={styles.railTitle}>Quick Tip</Text>
              <Text style={styles.railBody}>
                Select a member to see everything on file for them — documents
                you&apos;ve uploaded and files they&apos;ve shared in chat, all
                in one place.{'\n\n'}
                Members are sorted alphabetically and can be searched by name.
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

  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    height: 36,
  } as ViewStyle,

  backButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
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

  // ─── Landing member list ───────────────────────────────────────────────────
  memberListCard: {
    padding: 0,
    overflow: 'hidden',
    borderRadius: radius.xl,
  } as ViewStyle,

  memberListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.cardBorder,
    cursor: 'pointer' as unknown as undefined,
  } as ViewStyle,

  memberListRowHover: {
    backgroundColor: colors.gray100,
  } as ViewStyle,

  memberListRowText: {
    flex: 1,
    gap: 2,
  } as ViewStyle,

  memberListRowName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    lineHeight: 20,
  } as unknown as TextStyle,

  // ─── Member group / repository shared bits ─────────────────────────────────
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

  // ─── Repository body card ──────────────────────────────────────────────────
  memberGroupBody: {
    marginHorizontal: 2,
    overflow: 'hidden',
    borderRadius: radius.xl,
    padding: 0,
  } as ViewStyle,

  groupError: {
    fontSize: 13,
    color: '#dc2626',
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

  // ─── Repository rows section ───────────────────────────────────────────────
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

  docRowIconChat: {
    backgroundColor: '#eff6ff',
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
    cursor: 'pointer' as unknown as undefined,
    borderRadius: radius.sm,
  } as ViewStyle,

  pickerMemberRowHover: {
    backgroundColor: colors.gray100,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
      : {}),
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
    cursor: 'pointer' as unknown as undefined,
  } as ViewStyle,

  docTypeRowHover: {
    backgroundColor: colors.gray100,
    borderColor: colors.primary,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }
      : {}),
  } as ViewStyle,

  docTypeLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  } as unknown as TextStyle,
});
