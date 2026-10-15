/**
 * The main menu as a NEW message, with the pressed one left where it is.
 *
 * `menu:main` (and `menu`) draws the menu *in place* of the message it was
 * pressed on — right for a sub-screen's «В меню», where the old screen is the
 * one being navigated away from. Under a broadcast post or a notification it
 * wiped the very message the subscriber was reading: the post was gone the
 * moment they opened the menu (the owner, 15.10.2026). Those buttons ask for
 * `menu:new`, and the menu arrives below the post instead.
 */
export const MENU_ANEW_CALLBACK = 'menu:new';

/**
 * The callback data a pushed message's button is drawn with: «Главное меню»
 * under a notification or a broadcast (`menu:main`, or `menu` as an operator
 * types it in the panel's editor) opens the menu as a new message. Anything
 * else is drawn as it came.
 */
export function pushedCallbackData(data: string): string {
  return data === 'menu:main' || data === 'menu' ? MENU_ANEW_CALLBACK : data;
}
