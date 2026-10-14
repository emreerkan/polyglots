<?php
/**
 * Plugin Name: Lint Fixture
 * Text Domain: lint-fixture
 */

printf( __( 'Hello %s', 'lint-fixture' ), $name );

/* polyglots-ignore */
/* translators: %s: a place name */
printf( __( 'Welcome to %s...', 'lint-fixture' ), $place );

echo __( 'Order', 'lint-fixture' );

echo __( 'Post', 'lint-fixture' ); // polyglots-ignore ambiguous-word
