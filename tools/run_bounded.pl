#!/usr/bin/perl
# Usage: tools/run_bounded.pl <seconds|0> <command> [args...]

# Runs the command in its own process group; on timeout (seconds > 0) or on INT / TERM / HUP it kills that group and every
# descendant (TERM, then KILL after 2 s). Exit: the command's status, 124 on timeout, 128 + signal when interrupted.

# RUN_BOUNDED_PS=<file>: on timeout, snapshot the process table there before killing (hang diagnosis, H-44).
# macOS has no GNU timeout, and bash defers its own traps until a foreground child exits, so scripts wrap long steps in this.
use strict;
use warnings;
use POSIX qw(:sys_wait_h);

my $secs = shift @ARGV;
die "usage: run_bounded.pl <seconds|0> <command> [args...]\n" unless defined $secs && $secs =~ /^\d+$/ && @ARGV;
my $psfile = delete $ENV{RUN_BOUNDED_PS};
my $pid = fork;
die "fork: $!\n" unless defined $pid;
if (!$pid) {
  setpgrp(0, 0);
  # A background group reading the terminal gets SIGTTIN and stops, a new hang; wrapped scripts never need the keyboard
  open STDIN, '<', '/dev/null' if -t STDIN;
  exec @ARGV or do { print STDERR "run_bounded: cannot run $ARGV[0]: $!\n"; POSIX::_exit(127) };
}

my $status;
sub reaped { return 1 if defined $status; my $r = waitpid($pid, WNOHANG); $status = $? if $r == $pid; return defined $status }

# Descendants by parent pid, collected before killing so children reparented mid-kill are still known
sub tree {
  my %kids;
  for (`ps -A -o pid= -o ppid=`) { my ($p, $pp) = split; push @{ $kids{$pp} }, $p if defined $pp }
  my @all;
  my @q = ($pid);
  while (@q) { my $p = shift @q; push @all, $p; push @q, @{ $kids{$p} || [] } }
  return @all;
}

sub stop {
  my @t = tree();
  kill 'TERM', -$pid; kill 'TERM', @t;
  for (1 .. 20) { last if reaped() && !grep { $_ != $pid && kill 0, $_ } @t; select undef, undef, undef, 0.1 }
  kill 'KILL', -$pid; kill "KILL", grep { $_ != $pid } @t;
  kill "KILL", $pid unless defined $status;
  waitpid($pid, 0) unless defined $status;
}

my %num = (INT => 2, HUP => 1, TERM => 15);
for my $s (keys %num) { $SIG{$s} = sub { stop(); exit 128 + $num{$s} } }
sub snapshot {
  my @t = tree();
  (my $dir = $psfile) =~ s{/[^/]*$}{};
  mkdir $dir if $dir ne $psfile;
  open my $f, '>', $psfile or return;
  # npm's process.title rewrite can make macOS ps print the environment too, so mask secret-looking variables
  my @ps = map { s/\b(\w*(?:KEY|TOKEN|SECRET|PASS\w*|AUTH\w*))=\S+/$1=***/gir }
    ("# run_bounded timeout after ${secs}s: @ARGV\n", `ps -axww -o pid,ppid,pgid,stat,etime,command`);
  my %in = map { $_ => 1 } @t;
  print $f $ps[0], "# watched tree:\n", $ps[1], grep({ /^\s*(\d+)/ && $in{$1} } @ps), "\n# all processes:\n", @ps[1 .. $#ps];
}
$SIG{ALRM} = sub { snapshot() if $psfile; stop(); print STDERR "run_bounded: timed out after ${secs}s: @ARGV\n"; exit 124 };
alarm $secs if $secs > 0;
waitpid($pid, 0);
$status = $?;
alarm 0;
exit($status & 127 ? 128 + ($status & 127) : $status >> 8);
