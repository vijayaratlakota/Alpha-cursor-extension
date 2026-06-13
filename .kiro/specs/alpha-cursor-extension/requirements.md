# Requirements Document

## Introduction

Alpha Cursor (domain: alphacursor.com) is a Chrome browser extension that delivers a productivity toolkit through a custom radial/context options panel. The panel is triggered by a middle mouse button click while the extension is in the ON state, behaving analogously to the native right-click context menu but presenting Alpha Cursor's own tools. The options surfaced are context-aware: the panel adapts based on whether the cursor is over an image, a video, selected text, or generic page content.

The extension bundles twelve core tools: a cloud/local notepad clipboard, tab session save/restore, full-page screenshots, image saving with enhancement, cookie-consent popup removal, search-selected-text, a media downloader, a color picker, OCR text extraction, voice-to-text dictation, a tab shifter, and horizontal scroll. Cross-cutting concerns include a global ON/OFF toggle, per-user identity and data isolation for notepads, a settings/options page, a Notion-inspired visual design implemented with Tailwind CSS v4, and explicit permissions and privacy handling.

This document captures the user's intended requirements. Several capabilities (notably media downloading from YouTube, Instagram, Facebook, and Twitter/X) may conflict with those platforms' Terms of Service, and Chrome Manifest V3 imposes architectural constraints (service-worker background scripts, restricted remote code execution, limited persistent background processing). These constraints are recorded as explicit requirements and feasibility notes so that they are addressed during design rather than discovered during implementation.

## Glossary

- **Extension**: The Alpha Cursor Chrome browser extension as a whole, including its background service worker, content scripts, options page, and UI surfaces.
- **Options_Panel**: The custom radial/context UI surface that appears at the cursor position when the user middle-clicks while the Extension is ON.
- **Background_Worker**: The Manifest V3 background service worker that coordinates cross-tab actions, downloads, and storage.
- **Content_Script**: The script injected into web pages that detects context, renders the Options_Panel, and performs in-page actions.
- **Options_Page**: The Extension's settings page where the user configures preferences.
- **Toggle**: The global ON/OFF control that enables or disables the Extension's active behaviors.
- **User_Account**: The per-user identity that scopes a user's stored data (notepad entries, saved tab folders, settings).
- **Notepad**: The per-User_Account clipboard store that accumulates copied text entries.
- **Notepad_Entry**: A single piece of text captured into the Notepad.
- **Separator**: The user-chosen character or string inserted between Notepad_Entry items when joining or displaying them.
- **Tab_Folder**: A named collection of saved tab URLs created by the tab session save feature.
- **Context_Type**: The classification of what the cursor is over when middle-clicked; one of image, video, selected-text, or generic-page.
- **Color_Picker**: The eyedropper tool that samples an on-screen color and copies its code.
- **OCR_Selection**: The rectangular region the user drags to extract text from rendered page content, including images and video frames.
- **Voice_Transcriber**: The component that captures microphone audio and converts speech to text.
- **Tab_Shifter**: The radial panel that displays open tabs for quick switching.
- **Media_Downloader**: The component that downloads audio/video from supported media sites.
- **Notification**: A transient, Notion-styled in-page message confirming the outcome of an action.
- **Design_System**: The Notion-inspired visual design language defined in DESIGN.md and the notion-ui-skills skill.

## Requirements

### Requirement 1: Global ON/OFF Toggle

**User Story:** As a user, I want a single control to turn Alpha Cursor on or off, so that I can decide when the extension intercepts my interactions.

#### Acceptance Criteria

1. THE Extension SHALL provide a Toggle accessible from the Extension toolbar popup with two states: ON and OFF.
2. WHILE the Toggle is OFF, THE Extension SHALL NOT open the Options_Panel on a middle-click and SHALL allow the browser's default middle-click behavior to proceed.
3. WHILE the Toggle is ON, WHEN the user middle-clicks on a page, THE Content_Script SHALL open the Options_Panel at the cursor position.
4. WHEN the user changes the Toggle state, THE Extension SHALL persist the new state to extension storage within 500ms.
5. WHEN the browser starts, THE Extension SHALL restore the Toggle to its last persisted state.
6. WHILE the Toggle is OFF, THE Extension SHALL disable automatic behaviors including cookie-consent popup removal.

### Requirement 2: Context-Aware Options Panel

**User Story:** As a user, I want a middle-click options panel that shows tools relevant to what I clicked, so that I can act quickly without hunting through menus.

#### Acceptance Criteria

1. WHILE the Toggle is ON, WHEN the user presses the middle mouse button, THE Content_Script SHALL determine the Context_Type from the element under the cursor.
2. WHEN the element under the cursor is an image, THE Content_Script SHALL set the Context_Type to image.
3. WHEN the element under the cursor is a video, THE Content_Script SHALL set the Context_Type to video.
4. WHEN a non-empty text selection exists at the time of the middle-click, THE Content_Script SHALL set the Context_Type to selected-text, taking precedence over the type of the clicked element.
5. IF the element under the cursor matches no specialized Context_Type, THEN THE Content_Script SHALL set the Context_Type to generic-page.
6. WHEN the Options_Panel opens, THE Content_Script SHALL display the tool options applicable to the resolved Context_Type plus the context-independent tools.
7. THE Content_Script SHALL render the Options_Panel as a radial layout centered on the cursor position.
8. WHEN the cursor is near a viewport edge, THE Content_Script SHALL reposition the Options_Panel so that all options remain within the visible viewport.
9. WHEN the user clicks outside the Options_Panel or presses the Escape key, THE Content_Script SHALL close the Options_Panel.
10. WHEN the user selects an option in the Options_Panel, THE Content_Script SHALL close the Options_Panel and invoke the selected tool.
11. THE Options_Panel SHALL conform to the Design_System defined in DESIGN.md and the notion-ui-skills skill.

### Requirement 3: Per-User Identity and Data Isolation

**User Story:** As a user, I want my notepad and saved data tied to my own account, so that my data stays separate from other users of the extension.

#### Acceptance Criteria

1. THE Extension SHALL associate each User_Account with a unique identifier.
2. WHEN the Extension stores a Notepad_Entry, a Tab_Folder, or a setting, THE Extension SHALL scope the stored data to the active User_Account identifier.
3. WHEN the Extension reads stored data, THE Extension SHALL return only data scoped to the active User_Account identifier.
4. WHEN the Extension loads and no User_Account exists, THE Extension SHALL create a local User_Account identifier immediately, regardless of user activity.
5. IF creation of the local User_Account identifier fails, THEN THE Extension SHALL block all user-data storage until a local User_Account identifier is successfully created.
6. WHERE cloud synchronization is enabled, THE Extension SHALL synchronize the active User_Account's data across the user's signed-in browser instances.
7. WHERE cloud synchronization is disabled, THE Extension SHALL store the active User_Account's data only in local extension storage.

### Requirement 4: Notepad Clipboard Capture

**User Story:** As a user, I want every text copy I make to be saved into my notepad, so that I can collect text from many places without losing earlier copies.

#### Acceptance Criteria

1. WHILE the Toggle is ON, WHEN the user copies text in the browser, THE Extension SHALL append the copied text as a new Notepad_Entry to the active User_Account's Notepad, even when the storage quota would be exceeded.
2. THE Extension SHALL accept an unlimited number of Notepad_Entry items, bounded only by available storage.
3. WHEN the user copies text from any web page where the Content_Script is active, THE Extension SHALL capture that text regardless of the originating site.
4. IF a copy attempt would cause the Notepad to exceed the available storage quota, THEN THE Extension SHALL display a Notification stating that the storage limit is reached.
5. WHEN a Notepad_Entry is captured, THE Extension SHALL record the capture order so that entries are joined in capture sequence.

### Requirement 5: Notepad Separator Configuration

**User Story:** As a user, I want to choose the character placed between my copied entries, so that my combined text is formatted the way I need.

#### Acceptance Criteria

1. THE Options_Page SHALL provide a setting for the Separator with preset choices of comma, dash, and slash, plus a custom-character option.
2. WHERE the user selects the custom-character option, THE Options_Page SHALL accept a user-entered Separator string.
3. WHEN the user saves a Separator selection, THE Extension SHALL persist the Separator to the active User_Account's settings.
4. IF persistence of the Separator selection fails, THEN THE Extension SHALL complete the save operation silently and SHALL apply the new Separator for the current session.
5. IF no Separator has been configured, or IF the configured Separator is invalid or corrupted, THEN THE Extension SHALL use a comma as the default Separator.
6. WHEN the Extension joins Notepad_Entry items for display or copying, THE Extension SHALL insert the configured Separator between consecutive entries.

### Requirement 6: Notepad Copy All

**User Story:** As a user, I want to copy all my notepad entries at once, so that I can paste the whole collection into another application.

#### Acceptance Criteria

1. THE Notepad interface SHALL provide a "Copy All" action.
2. WHEN the user selects "Copy All", THE Extension SHALL join all Notepad_Entry items of the active User_Account using the configured Separator and write the result to the system clipboard.
3. WHEN the "Copy All" clipboard write completes successfully, THE Extension SHALL display a Notification confirming that all entries were copied.
4. IF the Notepad contains no entries when "Copy All" is selected, THEN THE Extension SHALL display a Notification stating that the Notepad is empty and SHALL NOT modify the system clipboard.
5. IF the clipboard write fails, THEN THE Extension SHALL display a Notification reporting the failure.

### Requirement 7: Save All Tabs

**User Story:** As a user, I want to save all my open tabs into a named folder, so that I can preserve a browsing session for later.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present a "Save all tabs" option.
2. WHEN the user selects "Save all tabs", THE Extension SHALL prompt the user for a Tab_Folder name.
3. WHEN the user confirms a Tab_Folder name, THE Background_Worker SHALL record the URLs and titles of all tabs open in the current window into a Tab_Folder scoped to the active User_Account.
4. IF the user enters a Tab_Folder name that already exists, THEN THE Extension SHALL prompt the user to choose between overwriting the existing Tab_Folder and entering a different name.
5. IF no tabs are open in the current window when "Save all tabs" is selected, THEN THE Extension SHALL display a Notification stating that there are no tabs to save and SHALL NOT create a Tab_Folder.
6. WHEN a Tab_Folder is saved successfully, THE Extension SHALL display a Notification confirming the save and reporting the number of tabs stored.
7. THE Background_Worker SHALL persist each Tab_Folder to the active User_Account's storage.

### Requirement 8: Restore Saved Tabs

**User Story:** As a user, I want to reopen a previously saved set of tabs, so that I can return to a saved session.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present an "Open all previously saved tabs" option.
2. WHEN the user selects "Open all previously saved tabs", THE Extension SHALL display the list of saved Tab_Folder items for the active User_Account.
3. WHEN the user selects a Tab_Folder from the list, THE Background_Worker SHALL open each URL stored in that Tab_Folder as a browser tab.
4. IF no tabs can be opened from the selected Tab_Folder, whether because the Tab_Folder contains no URLs or because all stored URLs are invalid or inaccessible, THEN THE Extension SHALL display a Notification stating that no tabs could be opened and SHALL NOT open any tabs.
5. WHERE a stored URL fails to open, THE Extension SHALL continue opening the remaining URLs and SHALL report the count of URLs that failed to open.
6. THE Extension SHALL provide a control to delete a saved Tab_Folder.

### Requirement 9: Full Web Page Screenshot

**User Story:** As a user, I want to capture an entire web page from top to bottom, so that I can save or share the full content as a file.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present a "Full web page screenshot" option.
2. WHEN the user selects "Full web page screenshot", THE Extension SHALL capture the full scrollable height of the page by automatically scrolling and stitching the captured regions into a single image.
3. THE Extension SHALL produce the captured image at a resolution of at least Full HD (1920px width equivalent) and SHALL support 2K-quality output where the page width permits.
4. WHEN the capture completes, THE Extension SHALL prompt the user to choose between downloading a PDF and downloading a high-quality image.
5. WHEN the user selects an output format, THE Extension SHALL generate the file in the chosen format and SHALL start the download automatically.
6. IF the capture fails before completion, THEN THE Extension SHALL display a Notification reporting the failure and SHALL NOT start a download.
7. WHILE the capture is in progress, THE Extension SHALL display a progress indicator styled per the Design_System.

### Requirement 10: Save Image with Enhancement

**User Story:** As a user, I want to download an image in different formats with an optional enhancement, so that I can save a higher-quality version of any image I find.

#### Acceptance Criteria

1. WHEN the Context_Type is image, THE Options_Panel SHALL present download options for PDF, JPG, and PNG, plus enhanced-JPG and enhanced-PNG variants.
2. WHEN the user selects a non-enhanced format, THE Extension SHALL convert the source image to the chosen format and SHALL start the download automatically.
3. WHEN the user selects an enhanced variant, THE Extension SHALL apply image enhancement to the source image, convert the result to the chosen format, and SHALL start the download automatically.
4. WHEN the source image is in WebP format, THE Extension SHALL decode the WebP source before conversion or enhancement.
5. IF the source image cannot be retrieved or decoded, THEN THE Extension SHALL display a Notification reporting the failure and SHALL NOT start a download.
6. WHEN a download starts successfully, THE Extension SHALL display a Notification confirming the download and the chosen format.

### Requirement 11: Cookie Consent Popup Removal

**User Story:** As a user, I want cookie consent popups removed automatically, so that I can browse without dismissing repetitive banners.

#### Acceptance Criteria

1. WHILE the Toggle is ON, WHEN a new page finishes loading, THE Content_Script SHALL detect and remove cookie-consent popup elements matching the Extension's consent-popup ruleset.
2. WHEN a page finishes loading and contains no matching cookie-consent popup, THE Content_Script SHALL take no removal action and SHALL treat the outcome as successful.
3. WHEN a cookie-consent popup is removed, THE Content_Script SHALL restore page scrolling if the popup had disabled it.
4. WHERE a cookie-consent popup is injected after initial page load, THE Content_Script SHALL detect and remove the popup when it appears.
5. THE Content_Script SHALL remove only elements that match the consent-popup ruleset and SHALL leave non-matching elements intact.
6. WHILE the Toggle is OFF, THE Content_Script SHALL NOT remove cookie-consent popups.

### Requirement 12: Search Selected Text in Sites

**User Story:** As a user, I want to search my selected text on specific sites, so that I can look it up where it is most relevant.

#### Acceptance Criteria

1. WHEN the Context_Type is selected-text, THE Options_Panel SHALL present a "Search in" option with sub-options for YouTube, Reddit, Quora, and additional configured sites.
2. WHEN the user selects a site sub-option, THE Extension SHALL open that site's search results for the selected text in a new browser tab.
3. THE Extension SHALL URL-encode the selected text before constructing the search URL.
4. IF the selected text is empty at the time the search is invoked, THEN THE Extension SHALL display a Notification stating that no text is selected and SHALL NOT open a new tab.
5. IF the new tab is blocked by the browser or fails to open for technical reasons, THEN THE Extension SHALL take no further action and SHALL NOT display a Notification.
6. THE Options_Page SHALL allow the user to add, remove, and reorder the sites listed under "Search in".

### Requirement 13: Media Downloader

**User Story:** As a user, I want to download videos and audio from supported media sites in my chosen format and quality, so that I can keep media for offline use.

#### Acceptance Criteria

1. WHEN the Context_Type is video on YouTube, THE Options_Panel SHALL present options to download as MP3 or MP4 with selectable quality and format choices.
2. WHEN the user selects a YouTube download option, THE Media_Downloader SHALL retrieve the media in the chosen format and quality and SHALL start the download automatically.
3. WHEN the cursor is over a post or video on Instagram, Facebook, or Twitter/X, THE Options_Panel SHALL present download options with selectable format and quality choices.
4. WHERE the target is a post on a supported social site, THE Options_Panel SHALL offer an "all posts" choice and a "selected posts" choice.
5. WHERE the target is a video on a supported social site, THE Options_Panel SHALL offer an "all videos" choice and a "selected videos" choice.
6. WHEN the user confirms a social-media download selection, THE Media_Downloader SHALL retrieve the selected media in the chosen format and quality and SHALL start the download automatically.
7. IF a media download fails, THEN THE Extension SHALL display a Notification reporting the failure and the affected item.
8. THE Extension SHALL present a Notification informing the user that downloading media from third-party platforms may be subject to those platforms' Terms of Service before the first media download.

### Requirement 14: Color Picker

**User Story:** As a user, I want to pick a color from the screen and copy its code, so that I can reuse that color elsewhere.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present a "Color picker" option.
2. WHEN the user selects "Color picker", THE Extension SHALL activate an eyedropper that follows the cursor.
3. WHEN the user clicks a pixel while the eyedropper is active, THE Color_Picker SHALL copy the sampled color code to the system clipboard.
4. IF color sampling fails due to permission or display errors, THEN THE Extension SHALL display a Notification reporting that the color could not be sampled and SHALL NOT modify the system clipboard.
5. WHEN a color code is copied, THE Extension SHALL display a Notification stating "color copied successfully" along with the copied color code.
6. WHEN the user presses the Escape key while the eyedropper is active, THE Color_Picker SHALL deactivate without copying a color.
7. THE Color_Picker SHALL copy the color code in a paste-ready text format.

### Requirement 15: Text Extraction (OCR)

**User Story:** As a user, I want to select a screen region and extract any text inside it, so that I can copy text from images and videos.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, image, or video, THE Options_Panel SHALL present a "Text extraction" option.
2. WHEN the user selects "Text extraction", THE Content_Script SHALL allow the user to drag a rectangular OCR_Selection over the page.
3. WHEN the user completes an OCR_Selection, THE Extension SHALL extract text contained within the selected region, including text rendered in images and video frames.
4. WHEN text extraction completes, THE Extension SHALL copy the extracted text to the system clipboard and SHALL display a Notification confirming the copy.
5. IF no text is detected within the OCR_Selection, THEN THE Extension SHALL display a Notification stating that no text was found and SHALL NOT modify the system clipboard.
6. WHEN the user presses the Escape key during OCR_Selection, THE Content_Script SHALL cancel the extraction.

### Requirement 16: Voice to Text

**User Story:** As a user, I want to dictate text with my voice, so that I can enter text without typing.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present a "Voice to text" option.
2. WHEN the user selects "Voice to text", THE Extension SHALL display a microphone control and SHALL begin capturing microphone audio after microphone permission is granted.
3. WHILE the Voice_Transcriber is capturing audio, WHEN speech is recognized, THE Extension SHALL convert the recognized speech into text and display the transcribed text.
4. WHEN the user stops the dictation, THE Extension SHALL make the transcribed text available to copy or insert.
5. IF microphone permission is denied, THEN THE Extension SHALL display a Notification stating that microphone access is required and SHALL NOT start capturing audio.
6. WHEN the focused element is an editable text field at the start of dictation, THE Extension SHALL insert the transcribed text into that field.

### Requirement 17: Tab Shifter

**User Story:** As a user, I want a radial view of all my open tabs around the cursor, so that I can switch tabs quickly.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present a "Tab shifter" option.
2. WHEN the user selects "Tab shifter", THE Extension SHALL display a radial panel around the cursor listing all tabs open in the current window.
3. THE Tab_Shifter SHALL display each tab's favicon and title.
4. WHEN the user selects a tab in the Tab_Shifter, THE Background_Worker SHALL activate the selected tab.
5. WHERE a tab has no available favicon, THE Tab_Shifter SHALL display a placeholder icon styled per the Design_System.
6. WHEN the user presses the Escape key while the Tab_Shifter is open, THE Extension SHALL close the Tab_Shifter without switching tabs.

### Requirement 18: Horizontal Scroll

**User Story:** As a user, I want to scroll horizontally with my mouse wheel, so that I can navigate wide content like spreadsheets and wide documents.

#### Acceptance Criteria

1. WHEN the Context_Type is generic-page, THE Options_Panel SHALL present a "Horizontal Scroll" option.
2. WHEN the user selects "Horizontal Scroll", THE Content_Script SHALL enable a mode in which mouse-wheel input scrolls the page or the targeted scrollable element horizontally.
3. WHILE horizontal-scroll mode is enabled, WHEN the user rotates the mouse wheel, THE Content_Script SHALL translate the vertical wheel delta into a horizontal scroll on the targeted scrollable element.
4. WHEN the user selects "Horizontal Scroll" again while horizontal-scroll mode is enabled, THE Content_Script SHALL disable horizontal-scroll mode.
5. WHILE horizontal-scroll mode is enabled, THE Extension SHALL display an indicator that the mode is active.

### Requirement 19: Settings / Options Page

**User Story:** As a user, I want a settings page, so that I can configure the extension's behavior in one place.

#### Acceptance Criteria

1. THE Extension SHALL provide an Options_Page accessible from the Extension toolbar popup and from the browser's extension management surface.
2. THE Options_Page SHALL allow the user to configure the Notepad Separator, the "Search in" site list, and cloud-synchronization preference.
3. WHEN the user changes a setting on the Options_Page, THE Extension SHALL persist the change to the active User_Account's settings within 500ms while allowing the user to continue interacting with the Options_Page.
4. THE Options_Page SHALL display the current Toggle state and allow the user to change it.
5. THE Options_Page SHALL conform to the Design_System defined in DESIGN.md and the notion-ui-skills skill.
6. THE Options_Page SHALL provide a control to clear all Notepad_Entry items for the active User_Account, and SHALL require confirmation before clearing.

### Requirement 20: Notion-Style Visual Design with Tailwind v4

**User Story:** As a user, I want the extension's interface to follow the Notion-inspired design language, so that it feels calm, consistent, and polished.

#### Acceptance Criteria

1. THE Extension SHALL implement all user-facing surfaces, including the Options_Panel, Options_Page, popup, and Notification, using Tailwind CSS v4.
2. THE Extension SHALL apply the color tokens, typography scale, spacing scale, radius scale, and elevation treatments defined in DESIGN.md.
3. THE Extension SHALL reserve the primary blue accent for primary actions, links, and focus states, consistent with the Design_System.
4. THE Extension SHALL set interface text in the Inter typeface family as specified by the Design_System.
5. WHEN an interactive element receives keyboard focus, THE Extension SHALL display a visible focus indicator consistent with the Design_System.
6. WHERE the user's system requests reduced motion, THE Extension SHALL honor the reduced-motion preference in its animations.
7. THE Extension SHALL provide an accessible label for every icon-only control.

### Requirement 21: Permissions and Privacy

**User Story:** As a user, I want clear control over the permissions and data the extension uses, so that I can trust how my information is handled.

#### Acceptance Criteria

1. THE Extension SHALL declare in its Manifest V3 manifest only the permissions required by its enabled features.
2. WHEN a feature first requires a host or device permission that has not been granted, THE Extension SHALL request that permission at the time the feature is invoked.
3. IF a required permission is denied, THEN THE Extension SHALL display a Notification explaining which feature is unavailable and SHALL allow the user to continue using other features.
4. THE Extension SHALL make a privacy statement available from the Options_Page describing what data is collected, where it is stored, and how it is used.
5. WHERE cloud synchronization is enabled, THE Extension SHALL transmit User_Account data only to the alphacursor.com service endpoints.
6. IF the alphacursor.com endpoints are unavailable while cloud synchronization is enabled, THEN THE Extension SHALL queue the data locally and transmit it when the endpoints become available.
7. WHEN the user clears their data from the Options_Page, THE Extension SHALL delete the corresponding stored data for the active User_Account from local storage and, where cloud synchronization is enabled, from the cloud store.

### Requirement 22: Manifest V3 and Platform Constraints

**User Story:** As a developer, I want the extension to operate within Chrome Manifest V3 and platform constraints, so that it is publishable and stable.

#### Acceptance Criteria

1. THE Extension SHALL be packaged as a Chrome Manifest V3 extension using a background service worker rather than a persistent background page.
2. THE Extension SHALL execute all logic from packaged scripts and SHALL NOT load or execute remote code, consistent with Manifest V3 restrictions.
3. WHEN the background service worker is terminated by the browser, THE Extension SHALL restore in-progress state from extension storage upon the worker's next activation where the operation supports resumption.
4. WHERE a requested capability is not permitted by the host platform or a target site's Terms of Service, THE Extension SHALL record the limitation in user-facing documentation and SHALL degrade gracefully by disabling the affected option.
5. THE Extension SHALL persist user data using the extension storage APIs so that data survives service-worker termination.
