/**
 * ProfilePictureEditor — reusable profile photo picker + crop/scale UI.
 *
 * Platform behaviour:
 *   - web:    <input type="file"> → react-easy-crop modal → cropped Blob → upload
 *   - native: expo-image-picker with allowsEditing:true (built-in crop/scale) → upload
 *
 * Upload flow:
 *   1. POST /upload/presigned-url  (purpose=profile_image)
 *   2. PUT <presigned-url> with image blob
 *   3. PUT /chw/profile | /member/profile with { profile_picture_url }
 *   4. Calls onChange(newUrl) — parent invalidates query and re-renders
 *
 * Validation:
 *   - File type: image/jpeg and image/png only
 *   - File size: max 5 MB
 *   - Both enforced before any network call
 *
 * Optimistic UI: local preview is shown immediately after crop; the avatar
 * updates before the network round-trip completes.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Camera } from 'lucide-react-native';

import { useUploadProfilePicture, useRemoveProfilePicture, type ProfilePictureRole } from '../../hooks/useApiQueries';
import { colors as tokens, radius, shadows, spacing } from '../../theme/tokens';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
]);

const ALLOWED_MIME_LABEL = 'JPEG or PNG';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProfilePictureEditorProps {
  /** Current profile picture URL. Null when no photo has been uploaded. */
  currentUrl: string | null | undefined;
  /** Called after a successful upload (new URL) or removal (null). */
  onChange: (newUrl: string | null) => void;
  /** Which profile endpoint to write the URL to after upload. */
  role: ProfilePictureRole;
  /** Rendered diameter of the avatar circle in dp (default 96). */
  size?: number;
  /** Two-letter initials shown when there is no photo (e.g. "AM"). */
  initials?: string;
  /** Background colour of the initials circle. Defaults to brand primary. */
  initialsBackground?: string;
}

// ─── Crop types (web only, react-easy-crop) ───────────────────────────────────

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a cropped image Blob from a source image URL and a pixel crop area.
 * Uses an off-screen HTML Canvas — web only.
 */
async function getCroppedBlob(
  imageSrc: string,
  pixelCrop: CropArea,
  outputMime: 'image/jpeg' | 'image/png',
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixelCrop.width;
      canvas.height = pixelCrop.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      ctx.drawImage(
        image,
        pixelCrop.x,
        pixelCrop.y,
        pixelCrop.width,
        pixelCrop.height,
        0,
        0,
        pixelCrop.width,
        pixelCrop.height,
      );
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Canvas toBlob returned null'));
          }
        },
        outputMime,
        0.92,
      );
    };
    image.onerror = () => reject(new Error('Failed to load image for cropping'));
    image.src = imageSrc;
  });
}

/**
 * Show a toast-like error. On web uses window.alert; on native uses Alert.alert.
 * Keeps the component dependency-free from toast libraries.
 */
function showError(message: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(message);
  } else {
    Alert.alert('Upload error', message);
  }
}

// ─── WebCropModal ─────────────────────────────────────────────────────────────

/**
 * Web-only modal that wraps react-easy-crop.
 * The Crop component is lazily required so native bundles never pay the cost.
 */
interface WebCropModalProps {
  imageSrc: string;
  outputMime: 'image/jpeg' | 'image/png';
  onCrop: (blob: Blob) => void;
  onClose: () => void;
}

function WebCropModal({ imageSrc, outputMime, onCrop, onClose }: WebCropModalProps): React.JSX.Element {
  // Lazy import — only valid on web at runtime
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const Cropper = (require('react-easy-crop') as { default: React.ComponentType<Record<string, unknown>> }).default;

  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<CropArea | null>(null);
  const [applying, setApplying] = useState(false);

  const handleCropComplete = useCallback(
    (_croppedArea: CropArea, croppedAreaPx: CropArea) => {
      setCroppedAreaPixels(croppedAreaPx);
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!croppedAreaPixels) return;
    setApplying(true);
    try {
      const blob = await getCroppedBlob(imageSrc, croppedAreaPixels, outputMime);
      onCrop(blob);
    } catch {
      showError('Could not process the image. Please try again.');
    } finally {
      setApplying(false);
    }
  }, [croppedAreaPixels, imageSrc, outputMime, onCrop]);

  return (
    <View style={cropModalStyles.overlay} accessibilityViewIsModal>
      <View style={cropModalStyles.dialog}>
        <Text style={cropModalStyles.title}>Crop & Scale Photo</Text>

        {/* react-easy-crop container — fixed height so the cropper has a
            known bounding box. Must be position:relative per the docs. */}
        <View style={cropModalStyles.cropArea}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            onCropChange={setCrop as (v: unknown) => void}
            onZoomChange={setZoom as (v: unknown) => void}
            onCropComplete={handleCropComplete as (a: unknown, b: unknown) => void}
            style={{
              containerStyle: { borderRadius: 8 },
              cropAreaStyle: { border: '2px solid #10B981' },
            }}
          />
        </View>

        {/* Zoom slider */}
        {Platform.OS === 'web' && (
          <View style={cropModalStyles.sliderRow}>
            <Text style={cropModalStyles.sliderLabel}>Zoom</Text>
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              style={{ flex: 1, accentColor: '#10B981' }}
              aria-label="Zoom level"
            />
          </View>
        )}

        <View style={cropModalStyles.actions}>
          <Pressable
            style={cropModalStyles.cancelBtn}
            onPress={onClose}
            disabled={applying}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
          >
            <Text style={cropModalStyles.cancelBtnText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[cropModalStyles.saveBtn, applying && cropModalStyles.saveBtnDisabled]}
            onPress={() => void handleSave()}
            disabled={applying}
            accessibilityRole="button"
            accessibilityLabel="Save cropped photo"
          >
            {applying ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Text style={cropModalStyles.saveBtnText}>Apply Crop</Text>
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const cropModalStyles = StyleSheet.create({
  overlay: {
    // position:'fixed' is web-only; cast through unknown to avoid TS error on native types.
    ...(({
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: 'rgba(0,0,0,0.65)',
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1000,
    } as unknown) as ViewStyle),
  } as ViewStyle,
  dialog: {
    backgroundColor: tokens.cardBg,
    borderRadius: radius.xl,
    padding: spacing.xl,
    width: 400,
    maxWidth: '92vw' as unknown as number,
    ...(shadows.card as object),
  } as ViewStyle,
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: tokens.textPrimary,
    marginBottom: spacing.lg,
    textAlign: 'center',
  } as TextStyle,
  cropArea: {
    // position:'relative' is needed by react-easy-crop internals (web).
    // Cast through unknown to avoid the 'absolute'|'relative' union complaint.
    ...(({ position: 'relative' } as unknown) as ViewStyle),
    width: '100%',
    height: 300,
    backgroundColor: '#000',
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  } as ViewStyle,
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  } as ViewStyle,
  sliderLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: tokens.textSecondary,
    minWidth: 36,
  } as TextStyle,
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  } as ViewStyle,
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: tokens.cardBorder,
    alignItems: 'center',
  } as ViewStyle,
  cancelBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: tokens.textSecondary,
  } as TextStyle,
  saveBtn: {
    flex: 2,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: tokens.primary,
    alignItems: 'center',
  } as ViewStyle,
  saveBtnDisabled: {
    opacity: 0.6,
  } as ViewStyle,
  saveBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  } as TextStyle,
});

// ─── Native image picker ───────────────────────────────────────────────────────

/**
 * Launch expo-image-picker with allowsEditing:true for native (iOS/Android).
 * Returns a {uri, mimeType} on success, or null if the user cancelled.
 *
 * Skips the requestMediaLibraryPermissionsAsync call on Android 13+ because
 * the photo picker API doesn't require it, but still checks on older versions.
 */
async function pickImageNative(): Promise<{ uri: string; mimeType: 'image/jpeg' | 'image/png' } | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const ImagePicker = require('expo-image-picker') as typeof import('expo-image-picker');

  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') {
    Alert.alert(
      'Permission required',
      'Compass needs access to your photo library to set a profile picture.',
    );
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 0.92,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  if (!asset) return null;

  const mime = asset.mimeType;
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    Alert.alert('Unsupported format', `Please pick a ${ALLOWED_MIME_LABEL} image.`);
    return null;
  }

  return { uri: asset.uri, mimeType: mime };
}

/**
 * Fetch a native URI as a Blob.
 * Works for both file:// URIs (local photo library) and asset-library:// URIs.
 */
async function uriBlobNative(uri: string, mimeType: 'image/jpeg' | 'image/png'): Promise<Blob> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Failed to read local image (${response.status})`);
  }
  const blob = await response.blob();
  // Guard size — fetch doesn't know about our 5 MB cap
  if (blob.size > MAX_FILE_BYTES) {
    throw new Error(`Image is larger than 5 MB. Please pick a smaller photo.`);
  }
  return new Blob([blob], { type: mimeType });
}

// ─── ProfilePictureEditor (main export) ───────────────────────────────────────

/**
 * ProfilePictureEditor renders an avatar circle with a camera-icon overlay.
 * Tapping the avatar opens the platform-appropriate photo picker.
 * A "Remove photo" link appears below the avatar when a photo is set.
 *
 * See module doc at the top of this file for full flow description.
 */
export function ProfilePictureEditor({
  currentUrl,
  onChange,
  role,
  size = 96,
  initials = '',
  initialsBackground,
}: ProfilePictureEditorProps): React.JSX.Element {
  const upload = useUploadProfilePicture(role);
  const remove = useRemoveProfilePicture(role);

  // Optimistic preview URI — shown immediately after crop before the upload
  // round-trip completes. Falls back to currentUrl (or null) otherwise.
  const [optimisticUrl, setOptimisticUrl] = useState<string | null | undefined>(undefined);

  // Web: holds the object-URL of the selected file while the crop modal is open.
  const [pendingWebSrc, setPendingWebSrc] = useState<string | null>(null);
  // Web: the resolved MIME type of the file in the crop modal.
  const [pendingMime, setPendingMime] = useState<'image/jpeg' | 'image/png'>('image/jpeg');

  // Web: hidden file input ref
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const displayUrl = optimisticUrl !== undefined ? optimisticUrl : (currentUrl ?? null);
  const isPending = upload.isPending || remove.isPending;

  // ── Web: file input change handler ──────────────────────────────────────────

  const handleWebFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Always reset the value so picking the same file twice triggers onChange
      if (event.target) event.target.value = '';
      if (!file) return;

      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        showError(`Only ${ALLOWED_MIME_LABEL} images are accepted.`);
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        showError(`File is too large. Maximum size is 5 MB.`);
        return;
      }

      const objectUrl = URL.createObjectURL(file);
      setPendingMime(file.type as 'image/jpeg' | 'image/png');
      setPendingWebSrc(objectUrl);
    },
    [],
  );

  // ── Web: after crop ──────────────────────────────────────────────────────────

  const handleWebCrop = useCallback(
    (blob: Blob) => {
      // Revoke the object-URL we created for the crop modal — no longer needed
      if (pendingWebSrc) {
        URL.revokeObjectURL(pendingWebSrc);
        setPendingWebSrc(null);
      }

      // Show optimistic preview
      const previewUrl = URL.createObjectURL(blob);
      setOptimisticUrl(previewUrl);

      const filename = `profile-${Date.now()}.${pendingMime === 'image/png' ? 'png' : 'jpg'}`;

      upload.mutate(
        { blob, filename, contentType: pendingMime },
        {
          onSuccess: (newUrl) => {
            // Revoke the temporary preview blob-URL now that we have the real URL
            URL.revokeObjectURL(previewUrl);
            setOptimisticUrl(undefined);
            onChange(newUrl);
          },
          onError: (err: unknown) => {
            URL.revokeObjectURL(previewUrl);
            setOptimisticUrl(undefined);
            const message =
              err instanceof Error ? err.message : 'Could not upload photo. Please try again.';
            showError(message);
          },
        },
      );
    },
    [pendingWebSrc, pendingMime, upload, onChange],
  );

  // ── Web: dismiss crop modal ──────────────────────────────────────────────────

  const handleWebCropClose = useCallback(() => {
    if (pendingWebSrc) URL.revokeObjectURL(pendingWebSrc);
    setPendingWebSrc(null);
  }, [pendingWebSrc]);

  // ── Native: tap to pick ───────────────────────────────────────────────────────

  const handleNativePick = useCallback(async () => {
    const picked = await pickImageNative();
    if (!picked) return;

    // Show optimistic preview immediately
    setOptimisticUrl(picked.uri);

    let blob: Blob;
    try {
      blob = await uriBlobNative(picked.uri, picked.mimeType);
    } catch (err: unknown) {
      setOptimisticUrl(undefined);
      const message = err instanceof Error ? err.message : 'Could not read the selected image.';
      Alert.alert('Upload error', message);
      return;
    }

    const filename = `profile-${Date.now()}.${picked.mimeType === 'image/png' ? 'png' : 'jpg'}`;

    upload.mutate(
      { blob, filename, contentType: picked.mimeType },
      {
        onSuccess: (newUrl) => {
          setOptimisticUrl(undefined);
          onChange(newUrl);
        },
        onError: (err: unknown) => {
          setOptimisticUrl(undefined);
          const message =
            err instanceof Error ? err.message : 'Could not upload photo. Please try again.';
          Alert.alert('Upload error', message);
        },
      },
    );
  }, [upload, onChange]);

  // ── Unified tap handler ───────────────────────────────────────────────────────

  const handleAvatarPress = useCallback(() => {
    if (isPending) return;
    if (Platform.OS === 'web') {
      fileInputRef.current?.click();
    } else {
      void handleNativePick();
    }
  }, [isPending, handleNativePick]);

  // ── Remove photo ─────────────────────────────────────────────────────────────

  const handleRemove = useCallback(() => {
    if (isPending) return;

    const proceed = (): void => {
      setOptimisticUrl(null);
      remove.mutate(undefined, {
        onSuccess: () => {
          setOptimisticUrl(undefined);
          onChange(null);
        },
        onError: (err: unknown) => {
          setOptimisticUrl(undefined);
          const message =
            err instanceof Error ? err.message : 'Could not remove photo. Please try again.';
          showError(message);
        },
      });
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      if (window.confirm('Remove your profile photo?')) proceed();
      return;
    }
    Alert.alert('Remove photo', 'Are you sure you want to remove your profile photo?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: proceed },
    ]);
  }, [isPending, remove, onChange]);

  // ── Render ────────────────────────────────────────────────────────────────────

  const circleStyle = [
    styles.circle,
    {
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: initialsBackground ?? tokens.primary,
    },
  ];

  const overlaySize = Math.max(24, size * 0.32);

  return (
    <View style={styles.root} accessibilityLabel="Profile photo editor">
      {/* Avatar circle — pressable to trigger picker */}
      <Pressable
        onPress={handleAvatarPress}
        disabled={isPending}
        accessibilityRole="button"
        accessibilityLabel={displayUrl ? 'Change profile photo' : 'Add profile photo'}
        accessibilityHint="Tap to pick a photo from your library"
        style={({ pressed }) => [
          styles.avatarWrap,
          { width: size, height: size, borderRadius: size / 2 },
          pressed && !isPending && styles.avatarWrapPressed,
        ]}
      >
        {/* Photo or initials */}
        <View style={circleStyle}>
          {displayUrl ? (
            <Image
              source={{ uri: displayUrl }}
              style={{
                width: size,
                height: size,
                borderRadius: size / 2,
              }}
              accessibilityLabel="Profile photo"
            />
          ) : (
            <Text
              style={[
                styles.initials,
                { fontSize: size * 0.35 },
              ]}
            >
              {initials}
            </Text>
          )}
        </View>

        {/* Camera overlay badge */}
        <View
          style={[
            styles.overlay,
            {
              width: overlaySize,
              height: overlaySize,
              borderRadius: overlaySize / 2,
              bottom: 0,
              right: 0,
            },
          ]}
        >
          {isPending ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Camera size={overlaySize * 0.5} color="#FFFFFF" />
          )}
        </View>
      </Pressable>

      {/* Remove photo link — only when a photo exists */}
      {!!displayUrl && !isPending && (
        <Pressable
          onPress={handleRemove}
          accessibilityRole="button"
          accessibilityLabel="Remove profile photo"
          style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
        >
          <Text style={styles.removeBtnText}>Remove photo</Text>
        </Pressable>
      )}

      {/* Pending label */}
      {isPending && (
        <Text style={styles.uploadingLabel}>Uploading…</Text>
      )}

      {/* Web: hidden file input */}
      {Platform.OS === 'web' && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png"
          style={{ display: 'none' }}
          onChange={handleWebFileChange}
          aria-hidden="true"
        />
      )}

      {/* Web: crop modal rendered as an overlay */}
      {Platform.OS === 'web' && pendingWebSrc && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={handleWebCropClose}
          accessibilityViewIsModal
        >
          <WebCropModal
            imageSrc={pendingWebSrc}
            outputMime={pendingMime}
            onCrop={handleWebCrop}
            onClose={handleWebCropClose}
          />
        </Modal>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    gap: spacing.sm,
  } as ViewStyle,
  avatarWrap: {
    position: 'relative',
    overflow: 'visible',
  } as ViewStyle,
  avatarWrapPressed: {
    opacity: 0.8,
  } as ViewStyle,
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  } as ViewStyle,
  initials: {
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  } as TextStyle,
  overlay: {
    position: 'absolute',
    backgroundColor: tokens.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: tokens.cardBg,
    ...(shadows.card as object),
  } as ViewStyle,
  removeBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  } as ViewStyle,
  removeBtnPressed: {
    opacity: 0.6,
  } as ViewStyle,
  removeBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#DC2626',
  } as TextStyle,
  uploadingLabel: {
    fontSize: 12,
    color: tokens.textSecondary,
  } as TextStyle,
});
