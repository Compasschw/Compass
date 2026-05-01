/**
 * app.config.ts — Expo dynamic config for Compass CHW
 *
 * OPERATOR CHECKLIST (one-time, pre-submission):
 *   - Bundle IDs are locked: com.joincompasschw.app (iOS + Android)
 *   - buildNumber + versionCode are managed by EAS (appVersionSource: "remote")
 *     DO NOT manually increment them here; EAS overrides at build time.
 *   - EXPO_PUBLIC_API_URL is injected per-profile from eas.json env blocks.
 *     All other server secrets (JWT_SECRET, DB_URL, etc.) stay on the backend
 *     and are NEVER present in this file or any committed env file.
 */

import { ExpoConfig, ConfigContext } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,

  name: "CompassCHW",
  slug: "compasschw-mobile",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  newArchEnabled: true,
  scheme: "compasschw",

  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#ffffff",
  },

  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.joincompasschw.app",
    /**
     * buildNumber is intentionally left as a static seed ("1") here.
     * With appVersionSource: "remote" in eas.json, EAS Cloud overrides this
     * automatically on every production build. Do not manually edit.
     */
    buildNumber: "1",
    // @ts-expect-error — `minimumOsVersion` is a real EAS field but missing
    // from the Expo SDK 54 IOS type. Sets the iOS deployment target.
    minimumOsVersion: "15.0",
    infoPlist: {
      // ---- Privacy usage strings (App Store review requirement) ----
      NSCameraUsageDescription:
        "CompassCHW uses the camera so Community Health Workers can capture credentials and members can upload documents during sessions.",
      NSPhotoLibraryUsageDescription:
        "CompassCHW uses your photo library to upload profile pictures and share documents during sessions.",
      NSMicrophoneUsageDescription:
        "CompassCHW uses the microphone to record sessions with your consent, for billing and quality assurance.",
      // ---- Background audio (session transcription) ----
      // Required so iOS continues microphone capture when the user switches
      // apps mid-session. expo-audio's allowsBackgroundRecording: true sets
      // the AVAudioSession category, but Apple also requires this Info.plist
      // key to be present at submission time.
      UIBackgroundModes: ["audio"],
      // ---- Encryption export compliance ----
      // Standard HTTPS / TLS only — no proprietary crypto. Set to false to
      // skip the annual encryption export compliance question in App Store Connect.
      ITSAppUsesNonExemptEncryption: false,
    },
  },

  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#ffffff",
    },
    package: "com.joincompasschw.app",
    /**
     * versionCode is the static seed. With appVersionSource: "remote" in
     * eas.json, EAS increments this automatically. Do not manually edit.
     */
    versionCode: 1,
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    permissions: [
      "android.permission.CAMERA",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
      "android.permission.RECORD_AUDIO",
    ],
  },

  web: {
    favicon: "./assets/favicon.png",
  },

  plugins: [
    "expo-font",
    "expo-secure-store",
    "expo-audio",
    [
      "expo-image-picker",
      {
        photosPermission:
          "CompassCHW needs access to your photos to upload profile pictures and session documents.",
        cameraPermission:
          "CompassCHW needs access to your camera to capture credentials and session documents.",
      },
    ],
    [
      "expo-document-picker",
      {
        iCloudContainerEnvironment: "Production",
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/icon.png",
        color: "#3D5A3E",
        defaultChannel: "default",
      },
    ],
    "expo-maps",
    /**
     * iOS 17+ Privacy Manifest (PrivacyInfo.xcprivacy)
     *
     * Apple requires all apps — and any SDK that uses "required reason" APIs —
     * to include a privacy manifest. This plugin writes the manifest into the
     * generated Xcode project at build time (managed workflow).
     *
     * Data categories declared below reflect Compass CHW's current feature set.
     * Review and update each release if new data types are collected.
     *
     * References:
     *   https://developer.apple.com/documentation/bundleresources/privacy_manifest_files
     *   https://docs.expo.dev/guides/apple-privacy-manifest/
     */
    [
      "expo-build-properties",
      {
        ios: {
          privacyManifests: {
            NSPrivacyAccessedAPITypes: [
              // UserDefaults — expo-secure-store + async-storage use this API
              {
                NSPrivacyAccessedAPIType:
                  "NSPrivacyAccessedAPICategoryUserDefaults",
                NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
              },
              // File timestamp APIs — used by Metro bundler artifact caching
              {
                NSPrivacyAccessedAPIType:
                  "NSPrivacyAccessedAPICategoryFileTimestamp",
                NSPrivacyAccessedAPITypeReasons: ["C617.1"],
              },
              // System boot time — react-native-reanimated uses this for
              // high-precision animation timestamps
              {
                NSPrivacyAccessedAPIType:
                  "NSPrivacyAccessedAPICategorySystemBootTime",
                NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
              },
            ],
            NSPrivacyCollectedDataTypes: [
              // --- Identifiers ---
              {
                NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeUserID",
                NSPrivacyCollectedDataTypeLinked: true,
                NSPrivacyCollectedDataTypeTracking: false,
                NSPrivacyCollectedDataTypePurposes: [
                  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                ],
              },
              {
                NSPrivacyCollectedDataType:
                  "NSPrivacyCollectedDataTypeDeviceID",
                NSPrivacyCollectedDataTypeLinked: true,
                NSPrivacyCollectedDataTypeTracking: false,
                NSPrivacyCollectedDataTypePurposes: [
                  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                ],
              },
              // --- Contact info ---
              {
                NSPrivacyCollectedDataType:
                  "NSPrivacyCollectedDataTypeEmailAddress",
                NSPrivacyCollectedDataTypeLinked: true,
                NSPrivacyCollectedDataTypeTracking: false,
                NSPrivacyCollectedDataTypePurposes: [
                  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                ],
              },
              {
                NSPrivacyCollectedDataType:
                  "NSPrivacyCollectedDataTypePhoneNumber",
                NSPrivacyCollectedDataTypeLinked: true,
                NSPrivacyCollectedDataTypeTracking: false,
                NSPrivacyCollectedDataTypePurposes: [
                  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                ],
              },
              // --- User content (audio recordings, masked calls) ---
              // Linked: false because session audio is not tied to a persistent
              // user profile — it is associated with an encounter record.
              // Revisit if recordings become linked to a named user account.
              {
                NSPrivacyCollectedDataType:
                  "NSPrivacyCollectedDataTypeAudioData",
                NSPrivacyCollectedDataTypeLinked: false,
                NSPrivacyCollectedDataTypeTracking: false,
                NSPrivacyCollectedDataTypePurposes: [
                  "NSPrivacyCollectedDataTypePurposeAppFunctionality",
                ],
              },
              // --- Health & Fitness (PLACEHOLDER) ---
              // Compass CHW manages health encounter data on the backend
              // (HIPAA BAA scope). No health data is collected *by the app
              // itself* on-device today. Uncomment and update this block when
              // any health-linked data is read from HealthKit or stored locally.
              //
              // {
              //   NSPrivacyCollectedDataType: "NSPrivacyCollectedDataTypeHealth",
              //   NSPrivacyCollectedDataTypeLinked: true,
              //   NSPrivacyCollectedDataTypeTracking: false,
              //   NSPrivacyCollectedDataTypePurposes: [
              //     "NSPrivacyCollectedDataTypePurposeAppFunctionality",
              //   ],
              // },
            ],
          },
        },
      },
    ],
  ],

  extra: {
    eas: {
      projectId: "ab68b883-cda1-45fd-bbb6-9c464a9be56f",
    },
  },

  owner: "compasschw",
});
