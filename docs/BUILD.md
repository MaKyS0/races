# Сборка Android APK/AAB и iOS IPA

Версии, на которых это реально проверено: Node 22, JDK 21 (Temurin/OpenJDK), Gradle 8.14.3 (wrapper), Android SDK
platform 36 + build-tools 36.0.0, Capacitor 8.5.3. Хост — Linux (контейнер без GPU и без устройств).

| Артефакт | Статус |
|---|---|
| `app-debug.apk` (≈4,6 МБ) | **Собран** локально, подпись debug-ключом, проверен `apksigner verify` (схема v2) и `aapt2 dump badging`. На устройстве/эмуляторе **не запускался**. |
| `app-release.apk` (3,4 МБ) | **Собран** и подписан **одноразовым тестовым ключом** (не сохранён, в репозитории его нет). Это проверка пайплайна подписи, а не готовый к публикации релиз. |
| `app-release.aab` | Задача настроена в скрипте, **не запускалась**. |
| iOS-проект (`ios/`) | Сгенерирован `cap add ios`; плагин, контроллер и правки `project.pbxproj` написаны вручную. **Ни разу не компилировался.** |
| **IPA** | **Не собран.** Сборка и подпись возможны только на macOS с Xcode и аккаунтом Apple Developer. |

## Общее

```bash
npm ci
npm test               # физика/трассы/ИИ должны проходить
npm run build          # vite → dist/
npx cap sync           # копирует dist/ в android/ и ios/ и обновляет плагины
```

`capacitor.config.json`: `appId = com.apexgp.simulator`, `webDir = dist`, схемы `https` (Android) и `capacitor` (iOS).
Для замеров на устройстве временно поставьте `android.webContentsDebuggingEnabled: true` (по умолчанию выключено).

## Android

### Подготовка окружения (Linux/macOS/Windows)

```bash
# JDK 17+ (проверено на 21), затем Android command-line tools:
export ANDROID_HOME=$HOME/android-sdk
mkdir -p $ANDROID_HOME/cmdline-tools
# скачайте commandlinetools-<os>-*_latest.zip с developer.android.com/studio, распакуйте в cmdline-tools/latest
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager "platforms;android-36" "build-tools;36.0.0" "platform-tools"
```

### Debug APK

```bash
bash scripts/build-android.sh debug
# → android/app/build/outputs/apk/debug/app-debug.apk   (applicationId com.apexgp.simulator.debug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Скрипт: проверяет `ANDROID_HOME`, пишет `android/local.properties`, делает `npm ci`, `vitest`, `vite build`,
`cap sync android` и `./gradlew assembleDebug`. Время чистой сборки на облачной ВМ без кэша — около 3 минут.

### Release (подпись)

1. Создайте хранилище ключей (один раз, храните вне репозитория и делайте резервную копию — потеря ключа = нельзя
   обновлять приложение):
   ```bash
   keytool -genkeypair -v -keystore apexgp-release.jks -alias apexgp -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Передайте параметры **одним из способов** (файл `android/keystore.properties` уже в `.gitignore`):
   ```properties
   # android/keystore.properties
   storeFile=/abs/path/apexgp-release.jks
   storePassword=...
   keyAlias=apexgp
   keyPassword=...
   ```
   или переменными окружения `APEX_KEYSTORE`, `APEX_KEYSTORE_PASSWORD`, `APEX_KEY_ALIAS`, `APEX_KEY_PASSWORD`.
3. Соберите:
   ```bash
   bash scripts/build-android.sh release apk   # android/app/build/outputs/apk/release/app-release.apk
   bash scripts/build-android.sh release aab   # …/bundle/release/app-release.aab (для Google Play)
   ```
   Без ключа Gradle выпустит `app-release-unsigned.apk`, а скрипт напишет предупреждение: такой файл установить нельзя.
4. Перед публикацией: увеличьте `versionCode`/`versionName` в `android/app/build.gradle`, замените иконки и сплэш
   (сейчас стандартные Capacitor), включите Play App Signing и заполните карточку приложения в Play Console.

Манифест: `sensorLandscape`, полноэкранный режим (immersive), `FLAG_KEEP_SCREEN_ON`, `setSustainedPerformanceMode`,
OpenGL ES 3.0 обязателен, `allowBackup=false`. Архитектуры: приложение чисто WebView + Java, собственных `.so` нет, поэтому
ограничений по ABI (arm64-v8a / armeabi-v7a) нет — их определяет WebView устройства. `minSdk 24`, `targetSdk 36`.

## iOS (только macOS)

Требуется: macOS 14+, Xcode 16+, членство Apple Developer Program, Node 20+. CocoaPods **не нужен** (Capacitor 8 использует
Swift Package Manager).

```bash
export APPLE_TEAM_ID=ABCDE12345            # 10 символов, Membership в developer.apple.com
bash scripts/build-ios.sh development      # или ad-hoc | app-store-connect
# → build-output/ios/*.ipa
```

- Автоматическая подпись: Xcode должен быть залогинен в аккаунт; скрипт вызывает `xcodebuild -allowProvisioningUpdates`.
- Ручная подпись (CI): задайте `PROFILE_NAME` (имя provisioning profile) и импортируйте сертификат/профиль в связку ключей —
  так делает `.github/workflows/ios.yml`.
- Шаблон `ios/signing/ExportOptions.plist.template` заполняется скриптом.
- Bundle id: `com.apexgp.simulator`. Ориентация: только landscape; статус-бар и home-индикатор скрыты; экран не гаснет.
- Что нужно доделать перед App Store: иконки и launch-экран (сейчас стандартные Capacitor), `PrivacyInfo.xcprivacy`,
  описание в App Store Connect, проверка на реальном устройстве.
- **Скрипт и проект написаны без доступа к Mac. Ожидайте, что при первом запуске потребуются правки** (в частности,
  ручные вставки в `project.pbxproj` для `MainViewController.swift` и `ThermalPlugin.swift`; если Xcode ругнётся — добавьте
  файлы в таргет App через интерфейс).

## CI (GitHub Actions)

- `.github/workflows/android.yml` — debug APK при каждом запуске; подписанные release APK/AAB, если заданы секреты
  `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- `.github/workflows/ios.yml` — `macos-15`; секреты `IOS_CERT_P12_B64`, `IOS_CERT_PASSWORD`, `IOS_PROFILE_B64`,
  `IOS_PROFILE_NAME`, `APPLE_TEAM_ID`. Без них падает на подписи и ничего не подделывает.
- **Оба workflow ещё ни разу не запускались на GitHub.**

## Нативный плагин Thermal

`ThermalPlugin.java` (Android, `PowerManager.getCurrentThermalStatus`, API 29+) и `ThermalPlugin.swift`
(`ProcessInfo.thermalState`) возвращают `{state: nominal|fair|serious|critical, powerSave}`. JS регистрирует его через
`registerPlugin('Thermal')` в `src/core/Perf.js` и опрашивает раз в 5 с. Плагин только читает состояние; игра сама снижает
свою нагрузку. Работа на реальном устройстве не проверена.
