<!-- Example project rules. Save as .github/ai-review.md in your repository. -->
- Text domain is "my-plugin". Every user-facing string must be translatable.
- Minimum PHP version is 7.4: no enums, no readonly properties.
- All AJAX handlers must call check_ajax_referer() and current_user_can().
- Use the plugin's My_Plugin_Logger class instead of error_log().
